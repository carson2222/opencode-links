#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { setTimeout as delay } from "node:timers/promises"
import pty from "node-pty"
import xterm from "@xterm/headless"

const COLS = 150
const ROWS = 40
const START_TIMEOUT = 30_000
const QUICK_GH = 1_000
const QUICK_TITLE = 1_500
const DELAYED = 5_000

const CASES = {
  mount: { observe: 15_000 },
  switch: { observe: 20_000, switchAfter: 2_000 },
  slowscan: { observe: 25_000, listMs: 8_000 },
  blur: { observe: 20_000, ghMs: 2_000, blurAfterGh: 300, focusAfterBlur: 500 },
  newrow: { observe: 15_000, ghMs: 500, inject: 43 },
}

function argumentsOf(argv) {
  const options = { expectDelay: false, out: undefined, packageRoot: undefined, cases: Object.keys(CASES) }
  const picked = []
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === "--help") {
      process.stdout.write(`Usage: node scripts/refresh-smoke.mjs --package <plugin folder> [--case ${Object.keys(CASES).join("|")}]... [--expect-delay] [--out <empty dir>]\n`)
      process.exit(0)
    }
    if (arg === "--expect-delay") {
      options.expectDelay = true
      continue
    }
    if (arg === "--package" || arg === "--out" || arg === "--case") {
      const value = argv[++index]
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`)
      if (arg === "--package") options.packageRoot = path.resolve(value)
      else if (arg === "--out") options.out = path.resolve(value)
      else {
        if (!CASES[value]) throw new Error(`Unknown case: ${value}`)
        picked.push(value)
      }
      continue
    }
    throw new Error(`Unknown argument: ${arg}`)
  }
  if (!options.packageRoot) throw new Error("--package is required")
  if (picked.length > 0) options.cases = picked
  return options
}

async function prepareOutput(requested) {
  if (!requested) return await fs.promises.mkdtemp(path.join(os.tmpdir(), "refresh-smoke-"))
  await fs.promises.mkdir(requested, { recursive: true, mode: 0o700 })
  if ((await fs.promises.readdir(requested)).length !== 0) throw new Error("--out must be empty")
  return requested
}

function lines(file) {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean)
  } catch (error) {
    if (error?.code === "ENOENT") return []
    throw error
  }
}

const GH = `#!/usr/bin/env node
const fs = require("node:fs")
const log = (line) => fs.appendFileSync(process.env.REFRESH_SMOKE_OUT + "/gh.log", Date.now() + " " + line + "\\n")
const query = process.argv.find((arg) => arg.startsWith("query=")) ?? ""
const numbers = [...query.matchAll(/(p\\d+): repository\\([^)]*\\) \\{ pullRequest\\(number: (\\d+)\\)/g)]
log("start " + numbers.map((match) => match[2]).join(","))
process.on("SIGTERM", () => { log("term"); process.exit(143) })
setTimeout(() => {
  const data = Object.fromEntries(numbers.map(([, alias, number]) => [alias, { pullRequest: { title: "Fresh title " + number, state: "OPEN", isDraft: false } }]))
  log("end")
  process.stdout.write(JSON.stringify({ data }))
}, Number(process.env.REFRESH_SMOKE_GH_MS) || 0)
`

function wrapperSource(entry, id, spec) {
  return `import actual from ${JSON.stringify(entry)}
import fs from "node:fs"

const spec = ${JSON.stringify(spec)}
const log = (line) => fs.appendFileSync(process.env.REFRESH_SMOKE_OUT + "/events.log", Date.now() + " " + line + "\\n")
function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"))
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")) }, { once: true })
  })
}

export default {
  id: ${JSON.stringify(id)},
  async setup(context) {
    const rootID = (await context.client.session.create({ title: "Refresh smoke" })).id
    const otherID = spec.switchAfter ? (await context.client.session.create({ title: "Other smoke" })).id : undefined
    const now = Date.now()
    const pull = (number) => ({ key: "github.com/acme/web#" + number, url: "https://github.com/acme/web/pull/" + number, host: "github.com", owner: "acme", repo: "web", number, created: now - 120_000 })
    const stale = (title) => ({ title, state: "open", checked: now - 10 * 60_000 })
    const issueID = "00000000-0000-4000-8000-000000000002"
    const infoKey = "linear:00000000-0000-4000-8000-000000000001:" + issueID
    const seeded = [
      ["chats", { byRoot: {
        [rootID]: { pulls: [pull(42)], pages: [], checkpoints: {}, touched: now },
        ...(otherID ? { [otherID]: { pulls: [pull(43)], pages: [], checkpoints: {}, touched: now } } : {}),
      } }],
      ["status", { byKey: { "github.com/acme/web#42": stale("Old stale title"), ...(otherID ? { "github.com/acme/web#43": stale("Other stale title") } : {}) } }],
      ["linear", {
        byRoot: { [rootID]: { items: [{ key: "linear:smoke:SMOKE-1", id: issueID, workspace: "smoke", identifier: "SMOKE-1", url: "https://linear.app/smoke/issue/SMOKE-1/x", created: now - 1, requested: true }], touched: now } },
        byKey: { [infoKey]: { key: infoKey, id: issueID, organizationID: "00000000-0000-4000-8000-000000000001", workspace: "smoke", identifier: "SMOKE-1", previousIdentifiers: [], title: "Fresh issue", url: "https://linear.app/smoke/issue/SMOKE-1/x", state: { name: "Done", type: "completed", color: "#22aa66" }, checked: now } },
        aliases: { "linear:smoke:SMOKE-1": infoKey },
        organizations: { smoke: "00000000-0000-4000-8000-000000000001" },
      }],
    ]
    for (const [key, value] of seeded) {
      const [snapshot, persist] = context.storage.store(key, { initial: value })
      await persist((draft) => Object.assign(draft, snapshot, value))
    }
    const injected = spec.inject ? {
      type: "assistant",
      time: { created: Date.now(), completed: Date.now() },
      content: [{
        type: "tool", name: "shell", time: { created: Date.now() },
        state: { status: "completed", input: { command: "gh pr create --fill" }, metadata: { exit: 0 }, content: [{ type: "text", text: "https://github.com/acme/web/pull/" + spec.inject }] },
      }],
    } : undefined
    const message = new Proxy(context.client.message, {
      get(target, prop) {
        const value = Reflect.get(target, prop)
        if (prop !== "list") return typeof value === "function" ? value.bind(target) : value
        return async (input, options) => {
          log("list.start " + input.type)
          if (spec.listMs) await wait(spec.listMs, options?.signal)
          const page = await value.call(target, input, options)
          if (!injected || input.sessionID !== rootID || input.type !== "assistant" || input.cursor) return page
          log("list.inject")
          return { ...page, data: [injected, ...page.data] }
        }
      },
    })
    const client = new Proxy(context.client, {
      get(target, prop) {
        if (prop === "message") return message
        const value = Reflect.get(target, prop)
        return typeof value === "function" ? value.bind(target) : value
      },
    })
    const cleanup = await actual.setup(new Proxy(context, { get: (target, prop) => prop === "client" ? client : Reflect.get(target, prop) }))
    setTimeout(() => context.ui.router.navigate({ type: "session", sessionID: rootID }), 100)
    let switched = false
    const watcher = otherID ? fs.watch(process.env.REFRESH_SMOKE_OUT, (_, file) => {
      if (file !== "switch" || switched) return
      switched = true
      log("navigate.other")
      context.ui.router.navigate({ type: "session", sessionID: otherID })
    }) : undefined
    return () => {
      watcher?.close()
      return cleanup?.()
    }
  },
}
`
}

async function runCase(name, options, root) {
  const spec = CASES[name]
  const out = path.join(root, name)
  const dirs = Object.fromEntries(["home", "config", "data", "state", "cache", "runtime", "cwd", "shims", "wrapper", "tmp"].map((dir) => [dir, path.join(out, dir)]))
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const packageJson = JSON.parse(fs.readFileSync(path.join(options.packageRoot, "package.json"), "utf8"))
  const entry = path.resolve(options.packageRoot, packageJson.exports["./tui"])
  fs.writeFileSync(path.join(dirs.shims, "gh"), GH, { mode: 0o700 })
  fs.writeFileSync(path.join(dirs.shims, "linear"), `#!/bin/sh\necho "$1" >> "$REFRESH_SMOKE_OUT/linear.log"\nexit 1\n`, { mode: 0o700 })
  fs.writeFileSync(path.join(dirs.shims, "open"), `#!/bin/sh\necho "$@" >> "$REFRESH_SMOKE_OUT/open.log"\n`, { mode: 0o700 })
  fs.writeFileSync(path.join(dirs.wrapper, "package.json"), JSON.stringify({ name: packageJson.name, type: "module", exports: { "./tui": "./tui.tsx" } }))
  fs.writeFileSync(path.join(dirs.wrapper, "tui.tsx"), wrapperSource(entry, packageJson.name, spec))

  const env = {
    ...process.env,
    HOME: dirs.home, USERPROFILE: dirs.home,
    XDG_CONFIG_HOME: dirs.config, XDG_DATA_HOME: dirs.data, XDG_STATE_HOME: dirs.state, XDG_CACHE_HOME: dirs.cache, XDG_RUNTIME_DIR: dirs.runtime,
    TMPDIR: dirs.tmp, TMP: dirs.tmp, TEMP: dirs.tmp,
    PATH: `${dirs.shims}${path.delimiter}${process.env.PATH ?? ""}`,
    TERM: "xterm-ghostty", TERM_PROGRAM: "ghostty", COLORTERM: "truecolor",
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_CLI_CONFIG_CONTENT: JSON.stringify({ terminal: { copy: "manual" }, plugins: [{ package: dirs.wrapper, options: { linear: { workspace: "smoke", teams: ["SMOKE"] } } }] }),
    REFRESH_SMOKE_OUT: out,
    REFRESH_SMOKE_GH_MS: String(spec.ghMs ?? 0),
  }
  for (const key of ["OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG_PATH", "GH_TOKEN", "GITHUB_TOKEN", "GH_HOST", "LINEAR_API_KEY"]) delete env[key]

  const term = new xterm.Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true })
  let queue = Promise.resolve()
  let exited
  const child = pty.spawn("opencode", ["--standalone"], { name: "xterm-ghostty", cols: COLS, rows: ROWS, cwd: dirs.cwd, env })
  const exit = new Promise((resolve) => child.onExit((event) => { exited = event; resolve(event) }))
  child.onData((data) => { queue = queue.then(() => new Promise((resolve) => term.write(data, resolve))) })
  const screen = () => {
    const buffer = term.buffer.active
    return Array.from({ length: ROWS }, (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "")
  }
  const row = (number) => screen().find((line) => line.includes(`#${number} `))
  const gh = () => lines(path.join(out, "gh.log")).map((line) => { const [at, kind, pulls] = line.split(" "); return { at: Number(at), kind, pulls } })
  const result = { case: name, spec }
  const seen = {}
  const mark = (key, value) => { if (value && seen[key] === undefined) seen[key] = Date.now() }

  try {
    const started = Date.now()
    while (!screen().some((line) => line.includes("Old stale title"))) {
      await queue
      if (exited || Date.now() - started > START_TIMEOUT) throw new Error("cached row never shown")
      await delay(20)
    }
    const t0 = Date.now()
    let blurAt, focusAt
    while (Date.now() - t0 < spec.observe) {
      await queue
      mark("title42", row(42)?.includes("Fresh title 42"))
      mark("row43", Boolean(row(43)))
      mark("title43", row(43)?.includes("Fresh title 43"))
      const calls = gh()
      const first = calls.find((call) => call.kind === "start")
      if (spec.switchAfter && seen.switch === undefined && Date.now() - t0 >= spec.switchAfter) {
        seen.switch = Date.now()
        fs.writeFileSync(path.join(out, "switch"), "")
      }
      if (spec.blurAfterGh && first && blurAt === undefined && Date.now() - first.at >= spec.blurAfterGh) { child.write("\x1b[O"); blurAt = Date.now() }
      if (blurAt !== undefined && focusAt === undefined && Date.now() - blurAt >= spec.focusAfterBlur) { child.write("\x1b[I"); focusAt = Date.now() }
      const done = spec.switchAfter || spec.inject ? seen.title43 : seen.title42
      if (done && Date.now() - done > 1_000) break
      await delay(20)
    }
    const rel = (at) => (at === undefined ? null : at - t0)
    const calls = gh()
    const starts = calls.filter((call) => call.kind === "start")
    Object.assign(result, {
      firstGhMs: rel(starts[0]?.at),
      title42Ms: rel(seen.title42),
      row43Ms: rel(seen.row43),
      title43Ms: rel(seen.title43),
      switchMs: rel(seen.switch),
      blurMs: rel(blurAt),
      focusMs: rel(focusAt),
      gh: calls.map((call) => `${rel(call.at)}ms ${call.kind}${call.pulls ? " " + call.pulls : ""}`),
      ghStarts: starts.length,
      ghTerms: calls.filter((call) => call.kind === "term").length,
      linearCalls: lines(path.join(out, "linear.log")).length,
      openCalls: lines(path.join(out, "open.log")).length,
      listCalls: lines(path.join(out, "events.log")).filter((line) => line.includes("list.start")).length,
    })
    fs.writeFileSync(path.join(out, "screen.txt"), screen().join("\n"))
  } catch (error) {
    result.error = String(error?.message ?? error).slice(0, 200)
  } finally {
    if (!exited) {
      child.write("\x03")
      await Promise.race([exit, delay(2_000)])
      if (!exited) { child.kill("SIGTERM"); await Promise.race([exit, delay(2_000)]) }
      if (!exited) { child.kill("SIGKILL"); await Promise.race([exit, delay(1_000)]) }
    }
    result.childExit = exited?.exitCode ?? null
  }
  result.assertions = assertionsFor(name, result, options.expectDelay)
  fs.writeFileSync(path.join(out, "result.json"), JSON.stringify(result, null, 2))
  return result
}

function assertionsFor(name, result, expectDelay) {
  const checks = []
  const check = (label, passed) => checks.push({ label, passed: Boolean(passed) })
  const timely = (label, value, quick) => expectDelay
    ? check(`${label} delayed past ${DELAYED} ms`, value !== null && value >= DELAYED)
    : check(`${label} within ${quick} ms`, value !== null && value <= quick)
  check("no harness error", !result.error)
  check("OpenCode exited cleanly", result.childExit === 0)
  check("fresh Linear cache skips the Linear CLI", result.linearCalls === 0)
  check("no URL opened", result.openCalls === 0)
  if (name === "mount" || name === "slowscan") {
    check("exactly one metadata load", result.ghStarts === 1 && result.ghTerms === 0)
    timely("first gh call after cached row", result.firstGhMs, QUICK_GH)
    timely("fresh title after cached row", result.title42Ms, QUICK_TITLE)
  }
  if (name === "switch") {
    if (!expectDelay) check("first root refreshed before switch", result.title42Ms !== null && result.title42Ms < result.switchMs)
    timely("switched root fresh title after switch", result.title43Ms === null ? null : result.title43Ms - result.switchMs, QUICK_TITLE)
  }
  if (name === "blur") {
    check("blur aborts the in-flight gh read", result.ghTerms === 1)
    check("refocus retries exactly once", result.ghStarts === 2)
    check("fresh title after refocus", result.title42Ms !== null && result.title42Ms > result.focusMs)
    check("refocus has no extra timer delay", result.title42Ms !== null && result.title42Ms - result.focusMs <= CASES.blur.ghMs + QUICK_TITLE)
  }
  if (name === "newrow") {
    check("both known and newly found rows receive metadata", result.title42Ms !== null && result.title43Ms !== null)
    if (!expectDelay)
      check("new row found before the first gh read returns", result.row43Ms !== null && result.firstGhMs !== null && result.row43Ms < result.firstGhMs + CASES.newrow.ghMs)
    const known = Math.max(result.title42Ms ?? Infinity, result.row43Ms ?? Infinity)
    check(`new row title within ${QUICK_TITLE} ms of known metadata and row`, Number.isFinite(known) && result.title43Ms !== null && result.title43Ms - known <= QUICK_TITLE)
  }
  return checks
}

const options = argumentsOf(process.argv.slice(2))
const root = await prepareOutput(options.out)
const results = []
for (const name of options.cases) results.push(await runCase(name, options, root))
const failed = results.flatMap((result) => result.assertions.filter((check) => !check.passed).map((check) => `${result.case}: ${check.label}`))
fs.writeFileSync(path.join(root, "summary.json"), JSON.stringify({ package: options.packageRoot, expectDelay: options.expectDelay, results }, null, 2))
for (const result of results)
  process.stdout.write(`${result.case}: gh ${result.firstGhMs}ms title42 ${result.title42Ms}ms row43 ${result.row43Ms}ms title43 ${result.title43Ms}ms switch ${result.switchMs}ms gh ${result.ghStarts}/${result.ghTerms} term\n`)
process.stdout.write(`${failed.length ? `FAIL:\n  ${failed.join("\n  ")}` : "PASS"}\nArtifacts: ${root}\n`)
if (failed.length) process.exitCode = 1
