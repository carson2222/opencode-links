#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { createServer } from "node:http"
import { setTimeout as delay } from "node:timers/promises"
import pty from "node-pty"
import xterm from "@xterm/headless"

const COLS = 150
const ROWS = 48
const START_TIMEOUT = 30_000
const OPEN_TIMEOUT = 5_000

function argumentsOf(argv) {
  const options = { expectDouble: false, out: undefined, packageRoot: undefined }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === "--help") {
      process.stdout.write("Usage: node scripts/sidebar-smoke.mjs --package <absolute plugin folder> [--expect-double] [--out <owned empty dir>]\n")
      process.exit(0)
    }
    if (arg === "--expect-double") {
      options.expectDouble = true
      continue
    }
    if (arg === "--package" || arg === "--out") {
      const value = argv[++index]
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`)
      if (arg === "--package") options.packageRoot = path.resolve(value)
      else options.out = path.resolve(value)
      continue
    }
    throw new Error(`Unknown argument: ${arg}`)
  }
  if (!options.packageRoot || !path.isAbsolute(options.packageRoot)) throw new Error("--package must name an absolute plugin folder")
  return options
}

async function prepareOutput(requested) {
  if (requested) {
    try {
      const stat = await fs.promises.lstat(requested)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("--out must be a real directory")
      if ((await fs.promises.readdir(requested)).length !== 0) throw new Error("--out must be empty")
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
      await fs.promises.mkdir(requested, { recursive: true, mode: 0o700 })
    }
    return requested
  }
  return await fs.promises.mkdtemp(path.join(os.tmpdir(), "sidebar-smoke-"))
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"))
}

function safeError(error) {
  if (error instanceof Error) return error.message.replace(/[\r\n]+/g, " ").slice(0, 240)
  return "Smoke harness failed"
}

function screenLines(term) {
  const buffer = term.buffer.active
  const lines = []
  for (let row = 0; row < ROWS; row++) {
    const line = buffer.getLine(buffer.viewportY + row)
    lines.push(line?.translateToString(true) ?? "")
  }
  return lines
}

function screenText(term) {
  return screenLines(term).join("\n")
}

function locate(term, needle) {
  const lines = screenLines(term)
  for (let row = 0; row < lines.length; row++) {
    const index = lines[row].indexOf(needle)
    if (index >= 0) return { row, index, line: lines[row] }
  }
  return undefined
}

function countInFile(file) {
  try {
    return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).length
  } catch (error) {
    if (error?.code === "ENOENT") return 0
    throw error
  }
}

function entriesInFile(file) {
  try {
    return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean)
  } catch (error) {
    if (error?.code === "ENOENT") return []
    throw error
  }
}

function writeShim(file, body) {
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o700 })
}

async function main() {
  const options = argumentsOf(process.argv.slice(2))
  if (process.platform !== "darwin") throw new Error("This smoke harness currently requires macOS open(1)")

  const out = await prepareOutput(options.out)
  const artifacts = {
    screen: path.join(out, "screen.txt"),
    colors: path.join(out, "screen.colors.txt"),
    raw: path.join(out, "pty.raw"),
    summary: path.join(out, "summary.json"),
    opener: path.join(out, "open.log"),
    gh: path.join(out, "gh.log"),
    linear: path.join(out, "linear.log"),
  }
  const summary = {
    scope: "synthetic isolated OpenCode session; no live chats or vendor reads",
    package: options.packageRoot,
    expectDouble: options.expectDouble,
    harnessPid: process.pid,
    childPid: undefined,
    childExit: undefined,
    serverMethods: [],
    steps: [],
    assertions: [],
    openerUrls: [],
    status: "running",
  }
  const server = createServer((request, response) => {
    summary.serverMethods.push(request.method ?? "unknown")
    if (request.method === "HEAD") {
      response.writeHead(200, { "content-length": "0" })
      response.end()
      return
    }
    response.writeHead(405)
    response.end()
  })
  let serverStarted = false
  let child
  let childExit
  let childExitPromise
  let term
  let raw = ""
  let outputQueue = Promise.resolve()
  let thrown

  const check = (name, passed, detail = "") => {
    const assertion = { name, passed, ...(detail ? { detail } : {}) }
    summary.assertions.push(assertion)
    if (!passed) throw new Error(`Assertion failed: ${name}`)
  }

  const waitFor = async (name, predicate, timeout = START_TIMEOUT) => {
    const started = Date.now()
    while (Date.now() - started < timeout) {
      await outputQueue
      if (predicate()) return
      if (childExit) throw new Error(`OpenCode exited before ${name}`)
      await delay(50)
    }
    throw new Error(`Timed out waiting for ${name}`)
  }

  const send = async (input) => {
    child.write(input)
    await delay(80)
    await outputQueue
  }

  const hover = async (x, y) => send(`\x1b[<35;${x + 1};${y + 1}M`)

  const click = async (marker, x, y, { button = 0, row = true } = {}) => {
    await hover(x, y)
    await waitFor(`hover on ${marker}`, () => {
      const found = locate(term, marker)
      if (found?.row !== y) throw new Error(`${marker} moved from row ${y} to ${found?.row ?? "none"} before click`)
      return !row || found.line.includes("×")
    }, 2_000)
    await send(`\x1b[<${button};${x + 1};${y + 1}M`)
    await send(`\x1b[<${button};${x + 1};${y + 1}m`)
  }

  const clickText = async (needle, options) => {
    const found = locate(term, needle)
    if (!found) throw new Error(`Cannot locate visible text for ${needle}`)
    const x = found.index + Math.floor(needle.length / 2)
    await click(needle, x, found.row, options)
    return { x, y: found.row }
  }

  const countOpens = () => countInFile(artifacts.opener)

  const recordOpenStep = async (name, url, expectedDelta, action) => {
    const before = countOpens()
    await action()
    const deadline = Date.now() + OPEN_TIMEOUT
    let stableSince
    while (Date.now() < deadline) {
      const count = countOpens()
      if (count > before + expectedDelta) break
      if (count === before + expectedDelta) {
        stableSince ??= Date.now()
        if (Date.now() - stableSince >= 140) break
      } else stableSince = undefined
      await delay(30)
    }
    const values = entriesInFile(artifacts.opener).slice(before)
    const passed = values.length === expectedDelta && values.every((value) => value === url)
    summary.steps.push({ name, expectedDelta, actualDelta: values.length, openerUrls: values })
    check(name, passed, `expected ${expectedDelta} exact URL open(s); observed ${values.length}`)
  }

  const assertNoOpen = async (name, action) => {
    const before = countOpens()
    await action()
    await delay(280)
    const delta = countOpens() - before
    summary.steps.push({ name, expectedDelta: 0, actualDelta: delta, openerUrls: entriesInFile(artifacts.opener).slice(before) })
    check(name, delta === 0, `expected no URL open; observed ${delta}`)
  }

  const hoverRowAndFindDismiss = async (marker) => {
    const found = locate(term, marker)
    if (!found) throw new Error(`Cannot locate row for ${marker}`)
    const markerX = found.index + Math.floor(marker.length / 2)
    await hover(markerX, found.row)
    await waitFor(`dismiss control for ${marker}`, () => {
      const line = screenLines(term)[found.row] ?? ""
      return line.includes("×")
    }, 2_000)
    const line = screenLines(term)[found.row] ?? ""
    const cross = line.indexOf("×")
    if (cross < 0) throw new Error(`Dismiss control not rendered for ${marker}`)
    return { row: found.row, cross }
  }

  const hideRow = async (marker, name) => {
    const before = countOpens()
    const dismiss = await hoverRowAndFindDismiss(marker)
    await click(marker, dismiss.cross, dismiss.row)
    await waitFor(`${name} hidden`, () => !locate(term, marker), 5_000)
    const delta = countOpens() - before
    summary.steps.push({ name: `${name} hide`, expectedDelta: 0, actualDelta: delta, openerUrls: entriesInFile(artifacts.opener).slice(before) })
    check(`${name} hide does not open`, delta === 0)
  }

  const restoreHidden = async (markers) => {
    const before = countOpens()
    await send("\x10")
    await send("Restore hidden links")
    await waitFor("Restore hidden links palette item", () => screenText(term).includes("Restore hidden links"), 5_000)
    await send("\r")
    for (const marker of markers)
      await waitFor(`${marker} restored`, () => Boolean(locate(term, marker)), 5_000)
    const delta = countOpens() - before
    summary.steps.push({ name: "restore hidden links", expectedDelta: 0, actualDelta: delta, openerUrls: entriesInFile(artifacts.opener).slice(before) })
    check("restore hidden links does not open", delta === 0)
  }

  try {
    const packageJson = readJson(path.join(options.packageRoot, "package.json"))
    const packageName = packageJson.name
    const exportTarget = packageJson.exports?.["./tui"]
    if (typeof packageName !== "string" || typeof exportTarget !== "string")
      throw new Error("Plugin package must expose a string ./tui entry")
    const tuiEntry = path.resolve(options.packageRoot, exportTarget)
    if (!fs.statSync(tuiEntry).isFile()) throw new Error("Plugin ./tui entry does not exist")
    summary.packageVersion = typeof packageJson.version === "string" ? packageJson.version : "unknown"

    const address = await new Promise((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject)
        const value = server.address()
        if (!value || typeof value === "string") reject(new Error("Could not bind owned loopback server"))
        else resolve(value.port)
      })
    })
    serverStarted = true

    const dirs = {
      home: path.join(out, "home"),
      config: path.join(out, "xdg-config"),
      data: path.join(out, "xdg-data"),
      state: path.join(out, "xdg-state"),
      cache: path.join(out, "xdg-cache"),
      runtime: path.join(out, "xdg-runtime"),
      cwd: path.join(out, "cwd"),
      shims: path.join(out, "shims"),
      wrapper: path.join(out, "wrapper"),
      tmp: path.join(out, "tmp"),
    }
    await Promise.all(Object.values(dirs).map((directory) => fs.promises.mkdir(directory, { recursive: true, mode: 0o700 })))

    writeShim(path.join(dirs.shims, "open"), 'printf \'%s\\n\' "$@" >> "$SIDEBAR_SMOKE_OUT/open.log"')
    writeShim(path.join(dirs.shims, "gh"), 'printf \'%s\\n\' "$@" >> "$SIDEBAR_SMOKE_OUT/gh.log"\nexit 1')
    writeShim(path.join(dirs.shims, "linear"), 'printf \'%s\\n\' "$@" >> "$SIDEBAR_SMOKE_OUT/linear.log"\nexit 1')

    fs.writeFileSync(path.join(dirs.wrapper, "package.json"), JSON.stringify({
      name: packageName,
      type: "module",
      exports: { "./tui": "./tui.tsx" },
    }, null, 2))
    const wrapperSource = `import actual from ${JSON.stringify(tuiEntry)}

export default {
  id: ${JSON.stringify(packageName)},
  async setup(context) {
    const info = await context.client.session.create({ title: "Sidebar smoke" })
    const rootID = info.id
    const now = Date.now()
    const created = now - 1000
    const port = ${address}
    const issueRows = Array.from({ length: 6 }, (_, index) => {
      const number = index + 1
      const identifier = "SMOKE-" + number
      const issueID = "00000000-0000-4000-8000-" + String(number).padStart(12, "0")
      return {
        item: {
          key: "linear:smoke:" + identifier,
          id: issueID,
          workspace: "smoke",
          identifier,
          url: "https://linear.app/smoke/issue/" + identifier + "/click-check",
          created: now - number,
          requested: true,
        },
        info: {
          key: "linear:00000000-0000-4000-8000-000000000001:" + issueID,
          id: issueID,
          organizationID: "00000000-0000-4000-8000-000000000001",
          workspace: "smoke",
          identifier,
          previousIdentifiers: [],
          title: "Click check " + number,
          url: "https://linear.app/smoke/issue/" + identifier + "/click-check",
          state: { name: "Done", type: "completed", color: "#22aa66" },
          checked: now,
        },
      }
    })
    const seeded = [
      ["chats", {
        byRoot: {
          [rootID]: {
            pulls: [{ key: "github.com/acme/web#42", url: "https://github.com/acme/web/pull/42", host: "github.com", owner: "acme", repo: "web", number: 42, created }],
            pages: [{ url: "http://localhost:" + port + "/x", origin: "http://localhost:" + port, label: "localhost:" + port + "/x", created }],
            checkpoints: {},
            touched: now,
          },
        },
      }],
      ["status", { byKey: { "github.com/acme/web#42": { title: "Reliable clicks", state: "open", checked: now } } }],
      ["linear", {
        byRoot: { [rootID]: { items: issueRows.map((row) => row.item), touched: now } },
        byKey: Object.fromEntries(issueRows.map((row) => [row.info.key, row.info])),
        aliases: Object.fromEntries(issueRows.map((row) => [row.item.key, row.info.key])),
        organizations: { smoke: "00000000-0000-4000-8000-000000000001" },
      }],
    ]
    for (const [key, value] of seeded) {
      const [snapshot, persist] = context.storage.store(key, { initial: value })
      await persist((draft) => Object.assign(draft, snapshot, value))
    }
    const cleanup = await actual.setup(context)
    setTimeout(() => context.ui.router.navigate({ type: "session", sessionID: rootID }), 100)
    return cleanup
  },
}
`
    fs.writeFileSync(path.join(dirs.wrapper, "tui.tsx"), wrapperSource)

    const environment = {
      ...process.env,
      HOME: dirs.home,
      USERPROFILE: dirs.home,
      XDG_CONFIG_HOME: dirs.config,
      XDG_DATA_HOME: dirs.data,
      XDG_STATE_HOME: dirs.state,
      XDG_CACHE_HOME: dirs.cache,
      XDG_RUNTIME_DIR: dirs.runtime,
      TMPDIR: dirs.tmp,
      TMP: dirs.tmp,
      TEMP: dirs.tmp,
      PATH: `${dirs.shims}${path.delimiter}${process.env.PATH ?? ""}`,
      TERM: "xterm-ghostty",
      TERM_PROGRAM: "ghostty",
      COLORTERM: "truecolor",
      OPENCODE_DISABLE_AUTOUPDATE: "true",
      OPENCODE_CLI_CONFIG_CONTENT: JSON.stringify({
        terminal: { copy: "manual" },
        plugins: [{ package: dirs.wrapper, options: { linear: { workspace: "smoke", teams: ["SMOKE"] } } }],
      }),
      SIDEBAR_SMOKE_OUT: out,
    }
    delete environment.OPENCODE_CONFIG_CONTENT
    delete environment.OPENCODE_CONFIG_DIR
    delete environment.OPENCODE_CONFIG_PATH

    term = new xterm.Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true, scrollback: 1000 })
    child = pty.spawn("opencode", ["--standalone"], {
      name: "xterm-ghostty",
      cols: COLS,
      rows: ROWS,
      cwd: dirs.cwd,
      env: environment,
    })
    summary.childPid = child.pid
    childExitPromise = new Promise((resolve) => child.onExit((event) => {
      childExit = event
      summary.childExit = event.exitCode
      resolve(event)
    }))
    child.onData((data) => {
      raw += data
      outputQueue = outputQueue.then(() => new Promise((resolve) => term.write(data, resolve)))
    })

    const providers = [
      { name: "Linear", marker: "SMOKE-1", url: "https://linear.app/smoke/issue/SMOKE-1/click-check" },
      { name: "Pull request", marker: "#42", url: "https://github.com/acme/web/pull/42" },
      { name: "Local page", marker: `localhost:${address}/x`, url: `http://localhost:${address}/x` },
    ]
    await waitFor("session tab and all three seeded providers", () =>
      screenLines(term)[0].includes("Sidebar smoke") && providers.every((provider) => locate(term, provider.marker)))
    check("one initial PR row", screenLines(term).filter((line) => line.includes("#42")).length === 1)
    check("one initial local row", screenLines(term).filter((line) => line.includes(`localhost:${address}/x`)).length === 1)
    check("first five Linear issues visible", [1, 2, 3, 4, 5].every((number) => locate(term, `SMOKE-${number}`)))
    check("sixth Linear issue initially hidden", !locate(term, "SMOKE-6"))
    check("Linear expansion control visible", Boolean(locate(term, "Show 1 more")))
    check("native OSC 8 retains seeded issue URL", /\x1b\]8;[^;]*;https:\/\/linear\.app\/smoke\/issue\/SMOKE-1\/click-check(?:\x1b\\|\x07)/.test(raw))

    for (const provider of providers) {
      const ordinaryDelta = options.expectDouble ? 2 : 1
      await recordOpenStep(`${provider.name} text click`, provider.url, ordinaryDelta, () => clickText(provider.marker))
      await recordOpenStep(`${provider.name} modified click`, provider.url, 1, () => clickText(provider.marker, { button: 16 }))
      const found = locate(term, provider.marker)
      if (!found) throw new Error(`Cannot locate whitespace row for ${provider.name}`)
      const textEnd = found.line.indexOf("×") >= 0 ? found.line.indexOf("×") : found.line.trimEnd().length
      const lastLabel = found.line.slice(0, textEnd).trimEnd().length - 1
      const whitespace = lastLabel + 1
      if (whitespace >= textEnd) throw new Error(`No clickable row whitespace for ${provider.name}`)
      await recordOpenStep(`${provider.name} row whitespace click`, provider.url, 1, () => click(provider.marker, whitespace, found.row))
    }

    await clickText("Show 1 more", { row: false })
    await waitFor("sixth Linear issue after expansion", () => Boolean(locate(term, "SMOKE-6")), 5_000)
    check("Show more expands all six issues", Boolean(locate(term, "Show less")))
    await clickText("Show less", { row: false })
    await waitFor("collapsed Linear issue list", () => !locate(term, "SMOKE-6"), 5_000)
    check("Show less collapses the sixth issue", !locate(term, "SMOKE-6"))

    await hideRow("SMOKE-1", "Linear issue")
    await restoreHidden(["SMOKE-1"])
    await hideRow("#42", "Pull request")
    await hideRow(`localhost:${address}/x`, "Local page")
    await restoreHidden(["#42", `localhost:${address}/x`])

    const beforeBlur = ["SMOKE-1", "#42", `localhost:${address}/x`].map((marker) => Boolean(locate(term, marker)))
    await send("\x1b[O")
    await delay(250)
    await send("\x1b[I")
    await delay(300)
    const afterFocus = ["SMOKE-1", "#42", `localhost:${address}/x`].map((marker) => Boolean(locate(term, marker)))
    check("focus blur and refocus preserve seeded rows", beforeBlur.every(Boolean) && afterFocus.every(Boolean))

    const vendorReads = countInFile(artifacts.gh) + countInFile(artifacts.linear)
    check("fresh caches avoid GitHub and Linear CLI reads", vendorReads === 0, `observed ${vendorReads} shim invocation(s)`)
    check("owned server only received HEAD probes", summary.serverMethods.length === 0 || summary.serverMethods.every((method) => method === "HEAD"))
    check("owned server received at least one liveness probe", summary.serverMethods.includes("HEAD"))
    summary.status = "passed"
  } catch (error) {
    thrown = error
    summary.status = "failed"
    summary.error = safeError(error)
  } finally {
    try {
      await outputQueue
      if (term) {
        fs.writeFileSync(artifacts.screen, `${screenText(term)}\n`)
        const colored = []
        const buffer = term.buffer.active
        for (let row = 0; row < ROWS; row++) {
          const line = buffer.getLine(buffer.viewportY + row)
          if (!line) continue
          let text = ""
          let previous = ""
          for (let col = 0; col < COLS; col++) {
            const cell = line.getCell(col)
            if (!cell) break
            const chars = cell.getChars() || " "
            let color = "default"
            if (!cell.isFgDefault()) {
              const value = cell.getFgColor()
              color = cell.isFgRGB() ? `#${value.toString(16).padStart(6, "0")}` : `p${value}`
            }
            if (chars.trim() && color !== previous) {
              text += `{${color}}`
              previous = color
            }
            text += chars
          }
          colored.push(text.trimEnd())
        }
        fs.writeFileSync(artifacts.colors, `${colored.join("\n")}\n`)
      }
    } catch (error) {
      if (!thrown) thrown = error
      summary.status = "failed"
      summary.error ??= safeError(error)
    }
    if (child && !childExit) {
      try {
        child.write("\x03")
        await Promise.race([childExitPromise, delay(2_000)])
        if (!childExit) {
          child.kill("SIGTERM")
          await Promise.race([childExitPromise, delay(2_000)])
        }
        if (!childExit) {
          child.kill("SIGKILL")
          await Promise.race([childExitPromise, delay(1_000)])
        }
      } catch {
        summary.cleanupError = "Could not confirm OpenCode child exit"
      }
    }
    if (child && !childExit) {
      thrown ??= new Error("OpenCode child did not exit during cleanup")
      summary.status = "failed"
    } else if (childExit && childExit.exitCode !== 0) {
      thrown ??= new Error(`OpenCode child exited with code ${childExit.exitCode}`)
      summary.status = "failed"
    }
    if (serverStarted) {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    }
    try {
      await outputQueue
      fs.writeFileSync(artifacts.raw, raw)
      summary.openerUrls = entriesInFile(artifacts.opener)
      summary.childExit ??= childExit?.exitCode
      summary.status = thrown ? "failed" : summary.status
      fs.writeFileSync(artifacts.summary, `${JSON.stringify(summary, null, 2)}\n`)
    } catch (error) {
      if (!thrown) thrown = error
      summary.status = "failed"
      summary.error ??= safeError(error)
    }
  }

  if (thrown) {
    process.stderr.write(`FAIL: ${safeError(thrown)}\nArtifacts: ${out}\n`)
    process.exitCode = 1
    return
  }
  process.stdout.write(`PASS: sidebar smoke (${summary.assertions.length} assertions)\nArtifacts: ${out}\n`)
}

main().catch((error) => {
  process.stderr.write(`FAIL: ${safeError(error)}\n`)
  process.exitCode = 1
})
