import { afterEach, beforeEach, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fetchStatuses, parse } from "../src/github.ts"
import { createIssues } from "../src/issues.ts"
import { createHidden } from "../src/hidden.ts"
import { issueIn } from "../src/linear.ts"
import { createLinks } from "../src/links.ts"
import { backoff, createRefresher } from "../src/provider.ts"
import { pullChanges } from "../src/pulls.ts"
import { createTracker } from "../src/tracker.ts"
import { tuiHost } from "../src/tui-host.ts"
import { createWatch } from "../src/watch.ts"

const pull = (number, repo = "web", created = 1) => ({
  key: `github.com/acme/${repo}#${number}`, url: `https://github.com/acme/${repo}/pull/${number}`,
  host: "github.com", owner: "acme", repo, number, created,
})
const session = (id, parentID) => ({ id, parentID, time: { created: 1, updated: 50 } })

let clock
const realNow = Date.now
beforeEach(() => {
  clock = 1_000_000
  Date.now = () => clock
})
afterEach(() => { Date.now = realNow })

function context(shared = new Map(), sessions = [session("root")]) {
  const handlers = new Map()
  return {
    shared,
    emit: (type, event) => handlers.get(type)?.forEach((handler) => handler(event)),
    storage: {
      store(key, options) {
        const state = shared.get(key) ?? structuredClone(options.initial)
        shared.set(key, state)
        return [state, async (mutation) => mutation(state)]
      },
    },
    data: {
      session: { get: (id) => structuredClone(sessions.find((entry) => entry.id === id)) },
      on(type, handler) {
        const set = handlers.get(type) ?? new Set()
        set.add(handler)
        handlers.set(type, set)
        return () => set.delete(handler)
      },
    },
    client: {
      session: {
        get: async ({ sessionID }) => structuredClone(sessions.find((entry) => entry.id === sessionID)),
        list: async ({ parentID }) => ({ data: structuredClone(sessions.filter((entry) => entry.parentID === parentID)), cursor: {} }),
      },
      message: { list: async () => ({ data: [], cursor: {} }) },
    },
  }
}

function refresher(load, shared = new Map(), ceiling, phase = () => "active", background) {
  const saved = new Map()
  let loads = 0
  const requests = []
  const provider = {
    id: "github",
    checked: (reference) => saved.get(reference.key) ?? 0,
    changed: (reference) => reference.created,
    phase,
    partition: () => "host",
    background,
    async load(references, signal) {
      loads++
      requests.push(references.map((reference) => reference.key))
      return load(references, signal, loads)
    },
    async save(references, _values, checked) {
      const changed = new Set(references.filter((reference) => !saved.has(reference.key)).map((reference) => reference.key))
      for (const reference of references) saved.set(reference.key, checked)
      return changed
    },
  }
  return { refresher: createRefresher(tuiHost(context(shared)), provider, { ceiling }), saved, shared, requests, get loads() { return loads } }
}

const ok = (references) => ({ values: new Map(references.map((reference) => [reference.key, {}])) })
const signal = () => new AbortController().signal

async function withGh(script, run) {
  const dir = mkdtempSync(path.join(tmpdir(), "fake-gh-"))
  writeFileSync(path.join(dir, "gh"), `#!/bin/sh\n${script}\n`)
  chmodSync(path.join(dir, "gh"), 0o755)
  const original = process.env.PATH
  process.env.PATH = `${dir}:${original}`
  try { await run() } finally {
    process.env.PATH = original
    rmSync(dir, { recursive: true, force: true })
  }
}

test("gh exiting 1 is a failure that keeps checked, the claim and backs off briefly", async () => {
  await withGh("exit 1", async () => {
    const statuses = await fetchStatuses([pull(1)])
    expect(statuses.problem).toBe("unavailable")
    expect([...statuses.failed]).toEqual([pull(1).key])

    const c = context(new Map(Object.entries({
      chats: { byRoot: { root: { pulls: [pull(1)], touched: clock } } },
      status: { byKey: { [pull(1).key]: { title: "Before", state: "open", checked: 1 } } },
    })), [session("root")])
    const links = createLinks(tuiHost(c), {})
    try {
      await links.tracker.refresh([pull(1)])
      expect(links.tracker.status(pull(1).key)).toEqual({ title: "Before", state: "open", checked: 1 })
      const claim = c.shared.get("refresh.github").claims[pull(1).key]
      expect(claim).toMatchObject({ checked: 1, attempts: 1 })
      expect(claim.retry - clock).toBeGreaterThanOrEqual(4_000)
      expect(claim.retry - clock).toBeLessThanOrEqual(6_000)
      expect(links.tracker.problem()).toBe("unavailable")
      expect(links.pullHint("root")).toBe("GitHub status unavailable")
      expect(c.shared.get("refresh.github").failures.github.until).toBe(clock)
    } finally { links.dispose() }
  })
})

test("graphql responses separate absent PRs, scoped failures, rate limits and malformed output", () => {
  const pulls = [pull(1), pull(2), pull(3), pull(4)]
  const body = {
    data: { p0: { pullRequest: { title: "A", state: "OPEN", isDraft: false } }, p1: null, p2: { pullRequest: null }, p3: null },
    errors: [
      { type: "NOT_FOUND", path: ["p1"] },
      { type: "NOT_FOUND", path: ["p2", "pullRequest"] },
      { type: "FORBIDDEN", path: ["p3"] },
    ],
  }
  const included = `HTTP/2.0 200 OK\nX-Ratelimit-Remaining: 4000\n\n${JSON.stringify(body)}`
  const result = parse(pulls, included, 1)
  expect([...result.statuses.keys()]).toEqual([pull(1).key])
  expect([...result.failed]).toEqual([pull(4).key])
  expect(result.problem).toBe("unavailable")

  const limited = parse(pulls, "HTTP/2.0 403 Forbidden\nX-Ratelimit-Remaining: 0\nX-Ratelimit-Reset: 2000\n\n{\"message\":\"API rate limit exceeded\"}", 1)
  expect(limited).toEqual({ statuses: new Map(), failed: new Set(pulls.map((item) => item.key)), problem: "rate-limited", reset: 2_000_000 })
  const graphLimited = parse(pulls, JSON.stringify({ errors: [{ type: "RATE_LIMITED" }] }), 1)
  expect(graphLimited.problem).toBe("rate-limited")
  expect(parse(pulls, "not json").problem).toBe("unavailable")
  expect(parse(pulls, JSON.stringify({ data: {} })).failed.size).toBe(4)
  expect(parse(pulls, JSON.stringify({ data: { p0: { pullRequest: { title: "A", state: "OPEN" } } } }), 1).problem).toBe("unavailable")
})

test("a PR GitHub reports as not found is not shown unless it was ever resolved", async () => {
  const body = { data: { p0: null, p1: null }, errors: [{ type: "NOT_FOUND", path: ["p0"] }, { type: "NOT_FOUND", path: ["p1"] }] }
  await withGh(`printf 'HTTP/2.0 200 OK\\n\\n%s' '${JSON.stringify(body)}'; exit 1`, async () => {
    const c = context(new Map(Object.entries({
      chats: { byRoot: { root: { pulls: [pull(1, "typo"), pull(2)], touched: clock } } },
      status: { byKey: { [pull(2).key]: { title: "Lost access", state: "open", checked: 1 } } },
    })), [session("root")])
    const links = createLinks(tuiHost(c), {})
    try {
      expect(links.pulls("root").map((item) => item.number).sort()).toEqual([1, 2])
      await links.tracker.refresh([pull(1, "typo"), pull(2)])
      expect(links.tracker.status(pull(1, "typo").key)).toMatchObject({ title: "", state: "unknown", checked: clock })
      expect(links.pulls("root").map((item) => item.number)).toEqual([2])
    } finally { links.dispose() }
  })
})

test("transient failures retry at 5, 15, 30 and 60 seconds; rate limits wait for reset", () => {
  const spans = [1, 2, 3, 4, 9].map((attempts) => backoff("unavailable", attempts, 0))
  ;[5_000, 15_000, 30_000, 60_000, 60_000].forEach((base, index) => {
    expect(spans[index]).toBeGreaterThanOrEqual(base * 0.8)
    expect(spans[index]).toBeLessThanOrEqual(base * 1.2)
  })
  expect(backoff("rate-limited", 1, 0, 120_000)).toBe(120_000)
  expect(backoff("rate-limited", 1, 0)).toBe(60_000)
})

test("a rate limit with a reset blocks the provider until that reset", async () => {
  const f = refresher(async (references) => ({ values: new Map(), problem: "rate-limited", failed: new Set(references.map((item) => item.key)), reset: clock + 300_000 }))
  await f.refresher.refresh([{ key: "a", created: 0 }], signal())
  expect(f.shared.get("refresh.github").failures.github.until).toBe(clock + 300_000)
  expect(f.refresher.due([{ key: "a", created: 0 }])).toBe(clock + 300_000)
})

test("a partial failure retries only the failed row and never stalls the others", async () => {
  const f = refresher(async (references) => ({
    values: new Map(references.filter((item) => item.key !== "bad").map((item) => [item.key, {}])),
    problem: "unavailable",
    failed: new Set(references.some((item) => item.key === "bad") ? ["bad"] : []),
  }))
  const rows = [{ key: "good", created: 0 }, { key: "bad", created: 0 }, { key: "gone", created: 0 }]
  await f.refresher.refresh(rows, signal())
  expect(f.refresher.problem()).toBeUndefined()
  expect(f.saved.get("good")).toBe(clock)
  expect(f.saved.get("gone")).toBe(clock)
  expect(f.saved.has("bad")).toBe(false)
  const claim = f.shared.get("refresh.github").claims.bad
  expect(claim.attempts).toBe(1)
  expect(f.refresher.due([rows[1]])).toBe(claim.retry)
  expect(f.refresher.due([rows[0]])).toBe(clock + 60_000)
})

test("due-at scheduling follows checked plus refresh exactly", async () => {
  const f = refresher(async (references) => ok(references), new Map(), 15_000)
  const row = { key: "a", created: 0 }
  await f.refresher.refresh([row], signal())
  expect(f.refresher.due([row])).toBe(clock + 15_000)
  clock += 14_999
  await f.refresher.refresh([row], signal())
  expect(f.loads).toBe(1)
  clock += 1
  await f.refresher.refresh([row], signal())
  expect(f.loads).toBe(2)
})

test("a dirty mark newer than the last read start forces a reload; older marks do not", async () => {
  const f = refresher(async (references) => ok(references))
  const row = { key: "a", created: 0 }
  await f.refresher.refresh([row], signal())
  await f.refresher.invalidate(["a"], [clock - 1])
  await f.refresher.refresh([row], signal())
  expect(f.loads).toBe(1)
  clock += 1_000
  await f.refresher.invalidate(["a"], [clock, clock + 5_000])
  expect(f.refresher.due([row])).toBe(clock)
  await f.refresher.refresh([row], signal())
  expect(f.loads).toBe(2)
  expect(f.refresher.due([row])).toBe(clock + 5_000)
  clock += 5_000
  await f.refresher.refresh([row], signal())
  expect(f.loads).toBe(3)
  expect(f.shared.get("refresh.github").dirty.a).toBeUndefined()
})

test("entry revalidates rows whose last read started over 15 seconds before entry, even closed ones", async () => {
  const f = refresher(async (references) => ok(references), new Map(), undefined, () => "terminal")
  const row = { key: "a", created: 0 }
  await f.refresher.refresh([row], signal())
  clock += 14_000
  await f.refresher.refresh([row], signal(), { entered: clock })
  expect(f.loads).toBe(1)
  clock += 1_001
  await f.refresher.refresh([row], signal())
  expect(f.loads).toBe(1)
  await f.refresher.refresh([row], signal(), { entered: clock })
  expect(f.loads).toBe(2)
  await f.refresher.refresh([row], signal(), { entered: clock })
  expect(f.loads).toBe(2)
})

test("a busy refresher replays every queued chat in one union batch", async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const requests = []
  const f = refresher(async (references, _signal, count) => {
    requests.push(references.map((item) => item.key))
    if (count === 1) await gate
    return ok(references)
  })
  const first = f.refresher.refresh([{ key: "a", created: 0 }], signal(), { scope: "one" })
  await Bun.sleep(150)
  await f.refresher.refresh([{ key: "b", created: 0 }], signal(), { scope: "two" })
  await f.refresher.refresh([{ key: "c", created: 0 }], signal(), { scope: "three" })
  release()
  await first
  for (let index = 0; index < 10; index++) await Bun.sleep(0)
  await Bun.sleep(150)
  expect(requests).toEqual([["a"], ["b", "c"]])
})

test.each([
  ["gh pr merge 42 --squash --delete-branch", [{ number: 42 }]],
  ["gh pr merge https://github.com/Acme/Web/pull/42 --auto", [{ host: "github.com", owner: "acme", repo: "web", number: 42 }]],
  ["gh pr merge --auto -R acme/web 42", [{ owner: "acme", repo: "web", number: 42 }]],
  ["gh pr close --repo=github.com/acme/web 7 -c 'not needed'", [{ host: "github.com", owner: "acme", repo: "web", number: 7 }]],
  ["cd web && gh pr ready", [{}]],
  ["gh pr edit --title Retitle --milestone 3 12", [{ number: 12 }]],
  ["gh pr review 5 --approve -b 'ok'; gh pr comment 6 --body x", [{ number: 5 }, { number: 6 }]],
  ["GH_REPO=acme/api gh pr reopen 9", [{ owner: "acme", repo: "api", number: 9 }]],
  ["out=$(gh pr merge 3 --merge) && echo $out", [{ number: 3 }]],
  ["gh pr view 42", []],
  ["echo 'gh pr merge 42'", []],
  ["gh pr create --fill", []],
])("pullChanges(%s)", (command, expected) => expect(pullChanges(command)).toEqual(expected))

function trackerFixture(sessions, extension, seed = {}) {
  const c = context(new Map(Object.entries(seed)), sessions)
  const tracker = createTracker(tuiHost(c), 60_000, extension)
  return { c, tracker }
}

function emitShell(c, sessionID, command, { exit = 0, failed = false, launched = true, text = "" } = {}) {
  c.emit("session.tool.input.started", { data: { id: command, sessionID, name: "shell" } })
  c.emit("session.tool.called", { created: clock - 2_000, data: { id: command, sessionID, input: { command } } })
  if (failed) c.emit("session.tool.failed", { data: { id: command, sessionID, error: { type: "aborted", message: "x" }, executed: false, ...(launched ? { metadata: { shellID: "sh_1" } } : {}) } })
  else c.emit("session.tool.success", { data: { id: command, sessionID, metadata: { exit }, content: [{ type: "text", text }] } })
}

test("a successful status-changing gh command marks only that chat's PR dirty at success time with settle rechecks", async () => {
  const { c, tracker } = trackerFixture([session("root"), session("child", "root"), session("other")], undefined, {
    chats: { byRoot: {
      root: { pulls: [pull(42), pull(43), pull(42, "api")], touched: clock },
      other: { pulls: [pull(42, "docs")], touched: clock },
    } },
  })
  try {
    emitShell(c, "child", "gh pr merge 42 -R acme/web --squash")
    await Bun.sleep(5)
    expect(c.shared.get("refresh.github").dirty).toEqual({ [pull(42).key]: [clock] })
    expect(c.shared.get("refresh.github").rechecks).toEqual({ [pull(42).key]: [15_000, 30_000, 60_000, 120_000].map((delay) => clock + delay) })
    emitShell(c, "root", "gh pr close 43 -R acme/web", { failed: true, launched: false })
    await Bun.sleep(5)
    expect(Object.keys(c.shared.get("refresh.github").dirty)).toEqual([pull(42).key])
    emitShell(c, "root", "gh pr comment --body hi", { failed: true })
    await Bun.sleep(5)
    expect(Object.keys(c.shared.get("refresh.github").dirty).sort()).toEqual([pull(42, "api").key, pull(42).key, pull(43).key].sort())
  } finally { tracker.dispose() }
})

test("a dirty PR reloads promptly despite a fresh TTL", async () => {
  await withGh(`cat <<'EOF'\nHTTP/2.0 200 OK\n\n{"data":{"p0":{"pullRequest":{"title":"T","state":"MERGED","isDraft":false}}}}\nEOF`, async () => {
    const { c, tracker } = trackerFixture([session("root")], undefined, {
      chats: { byRoot: { root: { pulls: [pull(42)], touched: clock } } },
      status: { byKey: { [pull(42).key]: { title: "T", state: "open", checked: clock - 1_000 } } },
    })
    try {
      await tracker.refresh([pull(42)])
      expect(tracker.status(pull(42).key).state).toBe("open")
      emitShell(c, "root", "gh pr merge 42")
      await Bun.sleep(5)
      expect(tracker.due([pull(42)])).toBe(clock)
      await tracker.refresh([pull(42)])
      expect(tracker.status(pull(42).key)).toEqual({ title: "T", state: "merged", checked: clock })
    } finally { tracker.dispose() }
  })
})

test("an observed PR state change rechecks that chat's Linear issues at +3 s and +15 s", async () => {
  const calls = []
  const extension = { version: 1, assistant: () => [], user: () => [], tool: () => [], save: async () => undefined,
    dirty: async (rootID, times) => { calls.push([rootID, times]) } }
  await withGh(`cat <<'EOF'\n{"data":{"p0":{"pullRequest":{"title":"T","state":"MERGED","isDraft":false}}}}\nEOF`, async () => {
    const { tracker } = trackerFixture([session("root")], extension, {
      chats: { byRoot: { root: { pulls: [pull(42)], touched: clock }, other: { pulls: [pull(1)], touched: clock } } },
      status: { byKey: { [pull(42).key]: { title: "T", state: "open", checked: 1 } } },
    })
    try {
      await tracker.refresh([pull(42)])
      expect(calls).toEqual([["root", [clock + 3_000, clock + 15_000]]])
      clock += 30 * 60_000
      await tracker.refresh([pull(42)], undefined, { revalidate: true })
      expect(calls).toHaveLength(1)
    } finally { tracker.dispose() }
  })
})

test("Linear: a read that starts after the command but before its success is followed by a reload", async () => {
  const options = { workspace: "acme", teams: ["WEB"] }
  const c = context()
  const host = tuiHost(c)
  let loads = 0
  const issues = createIssues(host, 60_000, options, createHidden(host), async () => {
    loads++
    return { issues: new Map() }
  })
  const tracker = createTracker(host, 60_000, issues.extension)
  try {
    const started = clock
    await issues.extension.save("root", [issueIn("WEB-100", started - 10_000, options)])
    c.emit("session.tool.input.started", { data: { id: "u", sessionID: "root", name: "shell" } })
    c.emit("session.tool.called", { created: started, data: { id: "u", sessionID: "root", input: { command: "linear issue update WEB-100 --state Done" } } })
    clock = started + 1_000
    await issues.refresh(issues.issues("root"), signal())
    expect(loads).toBe(1)
    clock = started + 2_000
    c.emit("session.tool.success", { data: { id: "u", sessionID: "root", metadata: { exit: 0 }, content: [{ type: "text", text: "Updated issue WEB-100" }] } })
    await Bun.sleep(5)
    await issues.refresh(issues.issues("root"), signal())
    expect(loads).toBe(2)
  } finally { tracker.dispose(); issues.dispose() }
})

test("Linear active rows follow refresh below 60 seconds", async () => {
  const options = { workspace: "acme", teams: ["WEB"] }
  const c = context()
  const host = tuiHost(c)
  let loads = 0
  const issues = createIssues(host, 15_000, options, createHidden(host), async () => {
    loads++
    return { issues: new Map() }
  })
  try {
    await issues.extension.save("root", [issueIn("WEB-100", 1, options)])
    await issues.refresh(issues.issues("root"), signal())
    expect(issues.due(issues.issues("root"))).toBe(clock + 15_000)
  } finally { issues.dispose() }
})

test("history reaches grandchildren and rootOf walks deep chains", async () => {
  const url = "https://github.com/acme/web/pull/9"
  const sessions = [session("root"), session("child", "root"), session("grandchild", "child")]
  for (let index = 0; index < 12; index++) sessions.push(session(`deep${index}`, index === 0 ? "grandchild" : `deep${index - 1}`))
  const c = context(new Map(), sessions)
  c.client.message.list = async ({ sessionID, type }) => ({
    data: sessionID === "grandchild" && type === "assistant" ? [{ type: "assistant", time: { created: 200, completed: 300 }, content: [{
      type: "tool", name: "shell", time: { created: 210 },
      state: { status: "completed", input: { command: "gh pr create --fill" }, metadata: { exit: 0 }, content: [{ type: "text", text: url }] },
    }] }] : [],
    cursor: {},
  })
  const tracker = createTracker(tuiHost(c), 60_000)
  try {
    expect(await tracker.scan("root")).toBe(true)
    expect(tracker.pulls("root").map((item) => item.number)).toEqual([9])
    expect(await tracker.rootOf("deep11")).toBe("root")
  } finally { tracker.dispose() }
})

test("a failed live save marks the family for a catch-up scan", async () => {
  const { c, tracker } = trackerFixture([session("root"), session("child", "root")])
  const original = c.storage.store
  c.storage.store = (key, options) => {
    const [state, update] = original(key, options)
    return [state, async (mutation) => {
      if (key === "chats" && c.failWrites) throw new Error("disk full")
      return update(mutation)
    }]
  }
  const fresh = createTracker(tuiHost(c), 60_000)
  tracker.dispose()
  try {
    c.failWrites = true
    emitShell(c, "child", "gh pr create --fill", { text: "https://github.com/acme/web/pull/5" })
    await Bun.sleep(5)
    expect(fresh.pending("root")).toBe(true)
    c.failWrites = false
    expect(await fresh.scan("root")).toBe(true)
    expect(fresh.pending("root")).toBe(false)
  } finally { fresh.dispose() }
})

test("page probes are due ten seconds after they start, not after they finish", async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => {
    clock += 100
    return new Response(null, { status: 200 })
  }
  const { tracker } = trackerFixture([session("root")])
  try {
    const started = clock
    await tracker.check(["http://localhost:9999"])
    expect(tracker.probeDue(["http://localhost:9999"])).toBe(started + 10_000)
  } finally { globalThis.fetch = original; tracker.dispose() }
})

test("the watch sleeps until the exact due time, refreshes every issue, and revalidates on focus", async () => {
  const timers = []
  const originalTimeout = globalThis.setTimeout
  globalThis.setTimeout = (handler, delay) => {
    timers.push({ handler, delay })
    return originalTimeout(() => undefined, 0)
  }
  const fire = async () => {
    const timer = timers.at(-1)
    clock += timer.delay
    timers.length = 0
    timer.handler()
    for (let index = 0; index < 5; index++) await Bun.sleep(0)
    return timer.delay
  }
  let checked = clock
  const refreshed = []
  const issues = Array.from({ length: 8 }, (_, index) => ({ key: `i${index}`, created: index }))
  const links = {
    enter: () => undefined,
    host: { on: () => () => undefined },
    pulls: () => [pull(1)],
    pages: () => [],
    allIssues: () => issues,
    tracker: {
      refresh: async (_rows, _signal, options) => {
        if (clock >= checked + 15_000) checked = clock
        refreshed.push(["pulls", options.entered === clock])
      },
      check: async () => undefined,
      scan: async () => true,
      due: () => checked + 15_000,
      probeDue: () => Number.POSITIVE_INFINITY,
      pending: () => false,
      subscribe: () => () => undefined,
    },
    issues: {
      refresh: async (rows, _signal, options) => { refreshed.push(["issues", rows.length, options.entered === clock]) },
      due: () => Number.POSITIVE_INFINITY,
      subscribe: () => () => undefined,
    },
  }
  const watch = createWatch(links, { root: () => "root", focused: () => true })
  try {
    for (let index = 0; index < 5; index++) await Bun.sleep(0)
    expect(refreshed).toContainEqual(["issues", 8, true])
    const start = clock
    expect(await fire()).toBe(10_000)
    expect(await fire()).toBe(5_005)
    expect(clock - start).toBe(15_005)
    expect(checked).toBe(clock)
    expect(await fire()).toBe(10_000)
    refreshed.length = 0
    watch.focus()
    await Bun.sleep(0)
    expect(refreshed).toEqual([["pulls", true], ["issues", 8, true]])
  } finally { watch.dispose(); globalThis.setTimeout = originalTimeout }
})
