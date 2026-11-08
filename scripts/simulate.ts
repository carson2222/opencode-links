// Deterministic day simulation: real plugin code, virtual clock, fake gh/linear.
// bun scripts/simulate.ts [--old <git rev>] [--json <file>]
import { plugin } from "bun"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const argv = process.argv.slice(2)
const flag = (name: string) => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : undefined }
const repo = path.resolve(import.meta.dir, "..")
const oldRev = flag("--old") ?? "main"
const jsonOut = flag("--json")
const child = path.join(import.meta.dir, "sim-child.ts")

const oldRoot = mkdtempSync(path.join(tmpdir(), "chat-links-sim-"))
execFileSync("sh", ["-c", `git -C ${JSON.stringify(repo)} archive ${oldRev} src | tar -x -C ${JSON.stringify(oldRoot)}`])
plugin({
  setup(build) {
    build.onLoad({ filter: /\/src\/.*\.ts$/ }, (args) => ({
      loader: "ts",
      contents: readFileSync(args.path, "utf8").replaceAll('"node:child_process"', JSON.stringify(child)),
    }))
  },
})

// ---------- virtual clock ----------
const SECOND = 1_000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const START = Date.parse("2026-10-28T08:00:00Z")
const realImmediate = setImmediate
type Timer = { id: number; at: number; fn: () => void; every?: number; unref(): Timer; ref(): Timer; hasRef(): boolean }
const clock = { now: START, seq: 0, timers: new Map<number, Timer>() }
function timer(fn: () => void, ms: number, every?: number): Timer {
  const item: Timer = {
    id: ++clock.seq, at: clock.now + Math.max(0, Number(ms) || 0), fn, every,
    unref: () => item, ref: () => item, hasRef: () => true,
  }
  clock.timers.set(item.id, item)
  return item
}
const clear = (item: unknown) => { if (item && typeof item === "object" && "id" in item && typeof item.id === "number") clock.timers.delete(item.id) }
Object.assign(globalThis, {
  setTimeout: (fn: () => void, ms?: number) => timer(fn, ms ?? 0),
  clearTimeout: clear,
  setInterval: (fn: () => void, ms?: number) => timer(fn, ms ?? 0, Math.max(1, ms ?? 0)),
  clearInterval: clear,
  fetch: async () => new Response(null, { status: 200 }),
})
Date.now = () => clock.now
const settle = async () => { for (let index = 0; index < 40; index++) await new Promise((resolve) => realImmediate(resolve)) }
async function runUntil(end: number, after: () => void) {
  for (;;) {
    let next: Timer | undefined
    for (const item of clock.timers.values()) if (!next || item.at < next.at || (item.at === next.at && item.id < next.id)) next = item
    if (!next || next.at > end) break
    clock.now = Math.max(clock.now, next.at)
    if (next.every) next.at += next.every
    else clock.timers.delete(next.id)
    next.fn()
    await settle()
    after()
  }
  clock.now = end
}

// ---------- deterministic randomness ----------
let seed = 1
const random = () => { seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31; return seed / 2 ** 31 }

// ---------- fake vendors ----------
type PullTruth = { state: "OPEN" | "MERGED" | "CLOSED"; title: string }
type IssueTruth = { id: string; identifier: string; type: string; name: string; title: string }
const ORG = "00000000-0000-4000-8000-0000000000aa"
const LATENCY = { gh: 700, linear: 500 }
let truth: { pulls: Map<number, PullTruth>; issues: Map<string, IssueTruth> }
let calls: { at: number; vendor: "gh" | "linear"; keys: number }[]
Object.assign(globalThis, {
  simExec(command: string, args: readonly string[], callback: (error: (Error & { code?: number }) | null, stdout: string, stderr: string) => void) {
    if (command !== "gh" && command !== "linear") return callback(Object.assign(new Error("ENOENT"), { code: "ENOENT" }), "", "")
    const at = clock.now
    let stdout = ""
    if (command === "gh") {
      const query = args.find((arg) => arg.startsWith("query=")) ?? ""
      const found = [...query.matchAll(/(p\d+): repository\([^)]*\) \{ pullRequest\(number: (\d+)\)/g)]
      calls.push({ at, vendor: "gh", keys: found.length })
      const data = Object.fromEntries(found.map(([, alias = "", number = ""]) => {
        const pull = truth.pulls.get(Number(number))
        return [alias, { pullRequest: pull ? { title: pull.title, state: pull.state, isDraft: false } : null }]
      }))
      stdout = (args.includes("--include") ? "HTTP/2.0 200 OK\n\n" : "") + JSON.stringify({ data })
    } else {
      const variables = JSON.parse(args[args.indexOf("--variables-json") + 1] ?? "{}") as { ids: string[] }
      calls.push({ at, vendor: "linear", keys: variables.ids.length })
      const nodes = variables.ids.flatMap((id) => {
        const issue = [...truth.issues.values()].find((item) => item.identifier === id.toUpperCase() || item.id === id.toLowerCase())
        return issue ? [{
          id: issue.id, identifier: issue.identifier, previousIdentifiers: [], title: issue.title,
          url: `https://linear.app/sim/issue/${issue.identifier}`, state: { name: issue.name, type: issue.type, color: "#5e6ad2" },
        }] : []
      })
      stdout = JSON.stringify({ data: { organization: { id: ORG, urlKey: "sim" }, issues: { nodes, pageInfo: { hasNextPage: false } } } })
    }
    timer(() => callback(null, stdout, ""), LATENCY[command])
  },
})

// ---------- plugin processes ----------
type Store = { value: Record<string, unknown> }
type Handler = (event: unknown) => void
type Links = {
  pulls(root: string): { key: string; number: number }[]
  allIssues(root: string): { key: string; identifier: string }[]
  rowsKey(root: string, expanded: boolean): string
  tracker: { status(key: string): { state: string; checked: number } | undefined }
  issues?: { info(issue: unknown): { checked: number; state: { type: string } } | undefined }
  dispose(): void
}
type Watch = { focus(): void; blur(): void; rootChanged(): void; update(): void; dispose(): void }
type Revision = {
  name: string
  createLinks(host: unknown, options: unknown): Links
  createWatch(links: Links, input: { root: () => string; focused: () => boolean; expanded: () => boolean }): Watch
  initial(key: string): Record<string, unknown>
}
type Proc = { name: string; domain: Map<string, Store>; handlers: Map<string, Set<Handler>>; links: Links; watch: Watch; root: string; focused: boolean; rows: string }

async function load(root: string, name: string): Promise<Revision> {
  const links = await import(path.join(root, "src/links.ts"))
  const watch = await import(path.join(root, "src/watch.ts"))
  const host = await import(path.join(root, "src/host.ts"))
  return { name, createLinks: links.createLinks, createWatch: watch.createWatch, initial: host.initial }
}

const ROOTS = ["r0", "r1", "r2", "r3", "r4", "r5"]
const MUTABLE = new Set(["r0", "r1", "r2", "r3"])
const OPTIONS = { linear: { workspace: "sim", teams: ["SIM"] } }

function makeProc(revision: Revision, name: string, domain: Map<string, Store>): Proc {
  const handlers = new Map<string, Set<Handler>>()
  const store = (key: string) => {
    if (!domain.has(key)) domain.set(key, { value: structuredClone(revision.initial(key)) })
    const entry = domain.get(key) as Store
    return { get value() { return entry.value }, async update(mutate: (draft: unknown) => void) { mutate(entry.value) } }
  }
  const session = (id: string) => ({ id, time: { created: 1, updated: 1, idle: 1 } })
  const host = {
    store,
    memory: <T extends object>(value: T) => ({ value, update(mutate: (draft: T) => void) { mutate(value) } }),
    client: () => ({
      session: {
        get: async ({ sessionID }: { sessionID: string }) => session(sessionID),
        list: async () => ({ data: [], cursor: {} }),
      },
      message: { list: async () => ({ data: [], cursor: {} }) },
    }),
    on(type: string, handler: Handler) {
      const set = handlers.get(type) ?? new Set<Handler>()
      set.add(handler)
      handlers.set(type, set)
      return () => set.delete(handler)
    },
    session: async (id: string) => session(id),
  }
  const links = revision.createLinks(host, OPTIONS)
  const proc: Proc = { name, domain, handlers, links, watch: undefined as unknown as Watch, root: "r0", focused: false, rows: "" }
  proc.watch = revision.createWatch(links, { root: () => proc.root, focused: () => proc.focused, expanded: () => false })
  proc.rows = links.rowsKey(proc.root, false)
  return proc
}

// ---------- scenario ----------
type Visit = { at: number; end: number; proc: Proc; root: string; rows: Map<string, { age: number | undefined; verified?: number; wrong: boolean; fixed?: number }> }

async function run(revision: Revision, processes: readonly ("tui" | "desktop")[]) {
  seed = 7
  clock.now = START
  clock.timers.clear()
  calls = []
  let nextPull = 100
  let nextIssue = 100
  truth = { pulls: new Map(), issues: new Map() }
  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
  const addIssue = (n: number, type = "started") => truth.issues.set(`SIM-${n}`, {
    id: uuid(n), identifier: `SIM-${n}`, type, name: type === "completed" ? "Done" : "In Progress", title: `Issue ${n}`,
  })
  const openPull = new Map<string, number>()
  const activeIssue = new Map<string, number>()
  const seedChats: Record<string, unknown> = {}
  const seedLinear: Record<string, unknown> = {}
  for (const [index, root] of ROOTS.entries()) {
    const numbers = [index * 10 + 1, index * 10 + 2]
    for (const number of numbers) truth.pulls.set(number, { state: "MERGED", title: `Merged ${number}` })
    if (MUTABLE.has(root)) {
      const number = index * 10 + 3
      numbers.push(number)
      truth.pulls.set(number, { state: "OPEN", title: `Open ${number}` })
      openPull.set(root, number)
    }
    seedChats[root] = {
      pulls: numbers.map((number) => ({
        key: `github.com/sim/repo#${number}`, url: `https://github.com/sim/repo/pull/${number}`,
        host: "github.com", owner: "sim", repo: "repo", number, created: START - HOUR,
      })),
      touched: START,
    }
    addIssue(index * 10 + 1)
    addIssue(index * 10 + 2, "completed")
    activeIssue.set(root, index * 10 + 1)
    seedLinear[root] = {
      items: [index * 10 + 1, index * 10 + 2].map((n) => ({
        key: `linear:sim:SIM-${n}`, workspace: "sim", identifier: `SIM-${n}`, url: `https://linear.app/sim/issue/SIM-${n}`, created: START - HOUR, requested: true,
      })),
      touched: START,
    }
  }
  const domains = new Map<string, Map<string, Store>>()
  const procs = processes.map((kind, index) => {
    const domainName = kind === "tui" ? "tui" : "desktop"
    if (!domains.has(domainName)) {
      const domain = new Map<string, Store>()
      domain.set("chats", { value: { byRoot: structuredClone(seedChats) } })
      domain.set("linear", { value: { byRoot: structuredClone(seedLinear), byKey: {}, aliases: {}, organizations: {} } })
      domains.set(domainName, domain)
    }
    return makeProc(revision, `${kind}${index}`, domains.get(domainName) as Map<string, Store>)
  })

  const emit = (type: string, event: unknown) => { for (const proc of procs) proc.handlers.get(type)?.forEach((handler) => handler(event)) }
  let callID = 0
  const shell = (root: string, command: string, output: string) => {
    const id = `call${++callID}`
    emit("session.tool.input.started", { created: clock.now, data: { id, sessionID: root, name: "shell" } })
    emit("session.tool.called", { created: clock.now, data: { id, sessionID: root, input: { command } } })
    emit("session.tool.success", { created: clock.now, data: { id, sessionID: root, metadata: { exit: 0 }, content: [{ type: "text", text: output }] } })
  }

  const visits: Visit[] = []
  let current: Visit | undefined
  const truthState = (key: string) => {
    if (key.startsWith("github.com/")) {
      const pull = truth.pulls.get(Number(key.split("#")[1]))
      return pull?.state.toLowerCase()
    }
    const id = key.split(":").at(-1) ?? ""
    return [...truth.issues.values()].find((issue) => issue.id === id || issue.identifier === id)?.type
  }
  const shown = (proc: Proc, key: string) => {
    if (key.startsWith("github.com/")) {
      const status = proc.links.tracker.status(key)
      return { state: status?.state, checked: status?.checked }
    }
    const issue = proc.links.allIssues(proc.root).find((item) => item.key === key)
    const info = issue ? proc.links.issues?.info(issue) : undefined
    return { state: info?.state.type, checked: info?.checked }
  }
  const observe = () => {
    for (const proc of procs) {
      const rows = proc.links.rowsKey(proc.root, false)
      if (rows !== proc.rows) {
        proc.rows = rows
        proc.watch.update()
      }
    }
    if (!current) return
    for (const [key, row] of current.rows) {
      const view = shown(current.proc, key)
      if (row.verified === undefined && (view.checked ?? 0) >= current.at - 15 * SECOND) row.verified = clock.now
      if (row.wrong && row.fixed === undefined && view.state === truthState(key)) row.fixed = clock.now
    }
  }
  const enter = (proc: Proc, root: string) => {
    if (current) current.end = clock.now
    for (const other of procs) if (other !== proc && other.focused) { other.focused = false; other.watch.blur() }
    const changed = proc.root !== root
    proc.root = root
    if (!proc.focused) { proc.focused = true; changed ? proc.watch.rootChanged() : proc.watch.focus() }
    else if (changed) proc.watch.rootChanged()
    const rows = new Map<string, Visit["rows"] extends Map<string, infer R> ? R : never>()
    const keys = [
      ...proc.links.pulls(root).filter((pull) => proc.links.tracker.status(pull.key)?.state !== "merged").map((pull) => pull.key),
      ...proc.links.allIssues(root).map((issue) => issue.key),
    ]
    for (const key of keys) {
      const view = shown(proc, key)
      const age = view.checked === undefined ? undefined : clock.now - view.checked
      const fresh = view.checked !== undefined && view.checked >= clock.now - 15 * SECOND
      rows.set(key, { age, wrong: view.state !== truthState(key), ...(fresh ? { verified: clock.now } : {}) })
    }
    current = { at: clock.now, end: clock.now, proc, root, rows }
    visits.push(current)
  }

  const WARMUP = HOUR
  const DAY = 8 * HOUR
  const END = START + WARMUP + DAY
  const entries: { at: number; proc: Proc; root: string }[] = []
  let previous = "r0"
  for (let at = START; at < END; at += 150 * SECOND) {
    let root = previous
    while (root === previous) root = ROOTS[Math.floor(random() * ROOTS.length)] ?? "r0"
    previous = root
    const proc = procs[Math.floor(random() * procs.length)] ?? procs[0]
    if (proc) entries.push({ at, proc, root })
  }
  const merges: { at: number; root: string; agent: boolean }[] = []
  for (let index = 0; index < 11; index++)
    merges.push({ at: START + WARMUP + Math.floor(((index + 0.5) * DAY) / 11), root: [...MUTABLE][Math.floor(random() * MUTABLE.size)] ?? "r0", agent: index % 5 !== 2 })
  for (const entry of entries) timer(() => enter(entry.proc, entry.root), entry.at - clock.now)
  for (const merge of merges) {
    timer(() => {
      const number = openPull.get(merge.root)
      const issue = activeIssue.get(merge.root)
      if (number === undefined) return
      const pull = truth.pulls.get(number)
      if (pull) pull.state = "MERGED"
      if (merge.agent) shell(merge.root, `gh pr merge ${number} --squash`, `Merged pull request #${number}`)
      timer(() => { const value = issue === undefined ? undefined : truth.issues.get(`SIM-${issue}`); if (value) { value.type = "completed"; value.name = "Done" } }, 3 * SECOND)
      timer(() => {
        const next = nextPull++
        const nextID = nextIssue++
        truth.pulls.set(next, { state: "OPEN", title: `Open ${next}` })
        openPull.set(merge.root, next)
        addIssue(nextID)
        activeIssue.set(merge.root, nextID)
        shell(merge.root, "gh pr create --fill", `https://github.com/sim/repo/pull/${next}`)
        shell(merge.root, "linear issue create --title next", `https://linear.app/sim/issue/SIM-${nextID}/next`)
      }, 5 * MINUTE)
    }, merge.at - clock.now)
  }
  await runUntil(END, observe)
  if (current) current.end = clock.now
  for (const proc of procs) { proc.watch.dispose(); proc.links.dispose() }
  await settle()

  const measured = visits.filter((visit) => visit.at >= START + WARMUP)
  const counted = calls.filter((call) => call.at >= START + WARMUP)
  const perHour = (vendor: "gh" | "linear") => counted.filter((call) => call.vendor === vendor).length / (DAY / HOUR)
  const rows = measured.flatMap((visit) => [...visit.rows.values()].map((row) => ({ ...row, at: visit.at, end: visit.end })))
  const ages = rows.map((row) => row.age ?? Number.POSITIVE_INFINITY)
  const verify = rows.map((row) => (row.verified ?? Number.POSITIVE_INFINITY) - row.at)
  const verifyEntry = measured.map((visit) => Math.max(0, ...[...visit.rows.values()].map((row) => (row.verified ?? Number.POSITIVE_INFINITY) - visit.at)))
  const verified = (values: readonly number[]) => ({
    ...quantiles(values), within2s: share(values, (value) => value <= 2 * SECOND), unverified: share(values, (value) => !Number.isFinite(value)),
  })
  const wrong = rows.filter((row) => row.wrong)
  return {
    revision: revision.name,
    processes: processes.join("+"),
    entries: measured.length,
    rows: rows.length,
    callsPerHour: { github: perHour("gh"), linear: perHour("linear") },
    keysPerCall: {
      github: counted.filter((call) => call.vendor === "gh").reduce((sum, call) => sum + call.keys, 0) / Math.max(1, counted.filter((call) => call.vendor === "gh").length),
      linear: counted.filter((call) => call.vendor === "linear").reduce((sum, call) => sum + call.keys, 0) / Math.max(1, counted.filter((call) => call.vendor === "linear").length),
    },
    ageAtEntrySeconds: quantiles(ages),
    timeToVerifiedSeconds: { perResource: verified(verify), perEntryAllShown: verified(verifyEntry) },
    wrongAtEntry: wrong.length,
    wrongFixedSeconds: quantiles(wrong.map((row) => (row.fixed ?? row.end) - row.at)),
    wrongUnfixedAtLeave: wrong.filter((row) => row.fixed === undefined).length,
  }
}

function quantiles(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  const pick = (q: number) => {
    const value = sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
    return value === undefined ? null : Number.isFinite(value) ? Math.round(value / 100) / 10 : "never"
  }
  return { p50: pick(0.5), p90: pick(0.9), max: pick(1) }
}
const share = (values: readonly number[], test: (value: number) => boolean) =>
  values.length === 0 ? 0 : Math.round((values.filter(test).length / values.length) * 1000) / 10

const revisions = [await load(oldRoot, oldRev), await load(repo, "new")]
const results = []
for (const processes of [["tui"], ["tui", "tui", "desktop"]] as const)
  for (const revision of revisions) results.push(await run(revision, processes))
console.log(JSON.stringify(results, null, 2))
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(results, null, 2))
rmSync(oldRoot, { recursive: true, force: true })
process.exit(0)
