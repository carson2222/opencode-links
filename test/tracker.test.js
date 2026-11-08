import { expect, setSystemTime, test } from "bun:test"
import { createTracker } from "../src/tracker.ts"
import { tuiHost } from "../src/tui-host.ts"

const url = "https://github.com/acme/web/pull/42"
const session = (id, updated, parentID) => ({ id, parentID, time: { created: 1, updated } })
const message = (created, completed, content = []) => ({ type: "assistant", time: { created, completed }, content })
const tool = (number = 42) => ({
  type: "tool",
  name: "shell",
  time: { created: 210 },
  state: {
    status: "completed",
    input: { command: "gh pr create --fill" },
    metadata: { exit: 0 },
    content: [{ type: "text", text: url.replace("42", String(number)) }],
  },
})

function deferred() {
  let resolve
  const promise = new Promise((finish) => { resolve = finish })
  return { promise, resolve: () => resolve() }
}

function fixture(sessions, messages, shared = new Map(), extension) {
  const handlers = new Map()
  const calls = []
  const writes = {}
  let written = deferred()
  const context = {
    storage: {
      store(key, options) {
        const state = shared.get(key) ?? structuredClone(options.initial)
        shared.set(key, state)
        return [state, async (mutation) => {
          writes[key] = (writes[key] ?? 0) + 1
          mutation(state)
          written.resolve()
        }]
      },
    },
    data: {
      session: { get: (id) => structuredClone(sessions.find((entry) => entry.id === id)) },
      on(type, handler) {
        handlers.set(type, handler)
        return () => handlers.delete(type)
      },
    },
    client: {
      session: {
        get: async ({ sessionID }) => structuredClone(sessions.find((entry) => entry.id === sessionID)),
        list: async ({ parentID }) => ({
          data: structuredClone(sessions.filter((entry) => entry.parentID === parentID)),
          cursor: {},
        }),
      },
      message: {
        list: async ({ sessionID, type }) => {
          calls.push(sessionID)
          return { data: structuredClone((messages[sessionID] ?? []).filter((message) => !type || message.type === type)), cursor: {} }
        },
      },
    },
  }
  const tracker = createTracker(tuiHost(context), 60_000, extension)
  return {
    tracker, context, calls, shared, writes,
    emit: (type, event) => handlers.get(type)?.(event),
    nextWrite() {
      written = deferred()
      return written.promise
    },
  }
}

test("catches root and child completion without changes to prompt timestamps", async () => {
  const messages = { root: [message(200)], child: [message(300)] }
  const f = fixture([session("root", 50), session("child", 100, "root")], messages)
  try {
    await f.tracker.scan("root")
    expect(f.shared.get("chats").byRoot.root.checkpoints.root.mark).toBe(199)
    expect(f.shared.get("chats").byRoot.root.checkpoints.child.mark).toBe(299)
    messages.root = [message(200, 500, [tool()])]
    messages.child = [message(300, 500, [tool(43)])]
    await f.tracker.scan("root")
    expect(f.tracker.pulls("root").map((pull) => pull.number).sort()).toEqual([42, 43])
  } finally { f.tracker.dispose() }
})

test("an older finished scan cannot hide a resumed child's later completion", async () => {
  const child = session("child", 100, "root")
  child.time.idle = 150
  const sessions = [session("root", 50), child]
  const messages = { root: [], child: [message(110, 140)] }
  const shared = new Map()
  const a = fixture(sessions, messages, shared)
  const b = fixture(sessions, messages, shared)
  const entered = deferred()
  const released = deferred()
  const list = a.context.client.message.list
  a.context.client.message.list = async (input) => {
    const snapshot = await list(input)
    if (input.sessionID === "child") { entered.resolve(); await released.promise }
    return snapshot
  }
  try {
    const earlier = a.tracker.scan("root")
    await entered.promise
    child.time.updated = 300
    messages.child = [message(400)]
    await b.tracker.scan("root")
    expect(shared.get("chats").byRoot.root.checkpoints.child.mark).toBe(399)
    released.resolve()
    await earlier
    expect(shared.get("chats").byRoot.root.checkpoints.child.mark).toBe(399)
    child.time.idle = 500
    messages.child = [message(400, 480, [tool()])]
    await b.tracker.scan("root")
    expect(b.tracker.pulls("root")).toHaveLength(1)
  } finally { released.resolve(); a.tracker.dispose(); b.tracker.dispose() }
})

test("two windows keep both PRs and independent session checkpoints", async () => {
  const sessions = [session("root", 50), session("first", 100, "root")]
  const messages = { root: [], first: [message(200, 250, [tool()])] }
  const shared = new Map()
  const a = fixture(sessions, messages, shared)
  const b = fixture(sessions, messages, shared)
  const entered = deferred()
  const released = deferred()
  const list = a.context.client.message.list
  a.context.client.message.list = async (input) => {
    const snapshot = await list(input)
    if (input.sessionID === "first") { entered.resolve(); await released.promise }
    return snapshot
  }
  try {
    const earlier = a.tracker.scan("root")
    await entered.promise
    sessions.push(session("second", 300, "root"))
    messages.second = [message(400, 450, [tool(43)])]
    await b.tracker.scan("root")
    released.resolve()
    await earlier
    expect(shared.get("chats").byRoot.root.checkpoints.root.mark).toBe(0)
    expect(shared.get("chats").byRoot.root.checkpoints.first.mark).toBe(200)
    expect(shared.get("chats").byRoot.root.checkpoints.second.mark).toBe(400)
    expect(a.tracker.pulls("root").map((pull) => pull.number).sort()).toEqual([42, 43])
  } finally { released.resolve(); a.tracker.dispose(); b.tracker.dispose() }
})

test("a legacy cache is rescanned once without losing links", async () => {
  const shared = new Map([["chats", { byRoot: { root: {
    pulls: [], pages: [], mark: 999, children: 999, running: [], touched: Date.now(),
  } } }]])
  const messages = { root: [message(200, 300, [tool(), { type: "text", text: "Open http://localhost:3000/app" }])] }
  const f = fixture([session("root", 50)], messages, shared)
  try {
    await f.tracker.scan("root")
    expect(f.tracker.pulls("root")).toHaveLength(1)
    expect(f.tracker.pages("root")[0].url).toBe("http://localhost:3000/app")
    expect(shared.get("chats").byRoot.root.checkpoints.root.mark).toBe(200)
    expect(shared.get("chats").byRoot.root.running).toBeUndefined()
    await f.tracker.scan("root")
    expect(f.tracker.pulls("root")).toHaveLength(1)
  } finally { f.tracker.dispose() }
})

test("live events persist links without querying GitHub or probing local servers", async () => {
  const f = fixture([session("root", 50)], { root: [] })
  try {
    const created = f.nextWrite()
    f.emit("session.tool.input.started", { data: { id: "call", sessionID: "root", name: "shell" } })
    f.emit("session.tool.called", { created: 200, data: { id: "call", sessionID: "root", input: { command: "gh pr create --fill" } } })
    f.emit("session.tool.success", { data: { id: "call", sessionID: "root", metadata: { exit: 0 }, content: [{ type: "text", text: url }] } })
    await created
    expect(f.tracker.pulls("root")).toHaveLength(1)
    const linked = f.nextWrite()
    f.emit("session.text.ended", { created: 250, data: { sessionID: "root", text: "Open http://localhost:3000" } })
    await linked
    expect(f.tracker.pages("root")).toHaveLength(1)
  } finally { f.tracker.dispose() }
})

test("local probes are bounded and stop when their visible section is cancelled", async () => {
  const f = fixture([session("root", 50)], {})
  const original = globalThis.fetch
  const controller = new AbortController()
  const entered = deferred()
  let count = 0
  globalThis.fetch = async (_url, options) => {
    count++
    if (count === 4) entered.resolve()
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true })
    })
  }
  try {
    const task = f.tracker.check(Array.from({ length: 12 }, (_, index) => `http://localhost:${3000 + index}`), controller.signal)
    await entered.promise
    expect(count).toBe(4)
    controller.abort()
    await task
    expect(count).toBe(4)
  } finally { controller.abort(); globalThis.fetch = original; f.tracker.dispose() }
})

test("unfinished snapshots retry after a failed scan without advancing checkpoints", async () => {
  const messages = { root: [message(200, 300, [tool()])] }
  const f = fixture([session("root", 50)], messages)
  const list = f.context.client.message.list
  f.context.client.message.list = async () => { throw new Error("Disconnected") }
  try {
    await f.tracker.scan("root")
    expect(f.shared.get("chats").byRoot.root).toBeUndefined()
    f.context.client.message.list = list
    await f.tracker.scan("root")
    expect(f.tracker.pulls("root")).toHaveLength(1)
    expect(f.shared.get("chats").byRoot.root.checkpoints.root.mark).toBe(200)
  } finally { f.tracker.dispose() }
})

test("an unchanged settled family costs no transcript reads after the first scan", async () => {
  const root = session("root", 50)
  root.time.idle = 60
  const children = Array.from({ length: 249 }, (_, index) => ({
    ...session(`child-${index}`, 100, "root"),
    time: { created: 1, updated: 100, idle: 300 },
  }))
  const sessions = [root, ...children]
  const messages = Object.fromEntries(children.map((child) => [child.id, [message(200, 250)]]))
  messages.root = []
  const f = fixture(sessions, messages)
  try {
    await f.tracker.scan("root")
    expect(f.calls).toHaveLength(251)
    const before = f.calls.length
    await f.tracker.scan("root")
    expect(f.calls).toHaveLength(before)
    children[0].time.updated = 350
    messages[children[0].id] = [message(400)]
    await f.tracker.scan("root")
    expect(f.calls.slice(before)).toEqual([children[0].id])
    children[0].time.idle = 500
    messages[children[0].id] = [message(400, 480, [tool()])]
    await f.tracker.scan("root")
    expect(f.tracker.pulls("root")).toHaveLength(1)
  } finally { f.tracker.dispose() }
})

test("a catch-up with nothing new leaves the chat store alone until its visit stamp is an hour old", async () => {
  const root = session("root", 50)
  root.time.idle = 60
  const f = fixture([root, { ...session("child", 100, "root"), time: { created: 1, updated: 100, idle: 300 } }], {
    root: [{ type: "user", text: "ship it", time: { created: 40 } }],
    child: [message(200, 250, [tool()])],
  })
  try {
    setSystemTime(new Date("2026-11-07T12:00:00Z"))
    await f.tracker.scan("root")
    const first = f.writes.chats
    const touched = f.shared.get("chats").byRoot.root.touched
    await f.tracker.scan("root")
    await f.tracker.scan("root")
    expect(f.writes.chats).toBe(first)
    setSystemTime(new Date("2026-11-07T13:00:01Z"))
    await f.tracker.scan("root")
    expect(f.shared.get("chats").byRoot.root.touched).toBeGreaterThan(touched)
    const retouched = f.writes.chats
    await f.tracker.scan("root")
    expect(f.writes.chats).toBe(retouched)
    expect(f.tracker.pulls("root")).toHaveLength(1)
  } finally {
    setSystemTime()
    f.tracker.dispose()
  }
})

test("newer completion stamps cannot be overwritten by older window snapshots", async () => {
  const root = session("root", 50)
  root.time.idle = 60
  const child = session("child", 100, "root")
  child.time.idle = 150
  const sessions = [root, child]
  const messages = { root: [], child: [message(110, 140)] }
  const shared = new Map()
  const a = fixture(sessions, messages, shared)
  const b = fixture(sessions, messages, shared)
  const entered = deferred()
  const released = deferred()
  const list = a.context.client.message.list
  a.context.client.message.list = async (input) => {
    const snapshot = await list(input)
    if (input.sessionID === "child") { entered.resolve(); await released.promise }
    return snapshot
  }
  try {
    const earlier = a.tracker.scan("root")
    await entered.promise
    child.time.updated = 300
    child.time.idle = 500
    messages.child = [message(400, 480, [tool()])]
    await b.tracker.scan("root")
    released.resolve()
    await earlier
    expect(shared.get("chats").byRoot.root.checkpoints.child).toEqual({ mark: 400, idle: 500, pullsVersion: 4 })
    const before = b.calls.length
    await b.tracker.scan("root")
    expect(b.calls).toHaveLength(before)
    expect(b.tracker.pulls("root")).toHaveLength(1)
  } finally { released.resolve(); a.tracker.dispose(); b.tracker.dispose() }
})

test("failed gh pr create cannot attribute an existing PR during history scan", async () => {
  const failed = tool()
  failed.state.metadata.exit = 1
  failed.state.content[0].text = `a pull request for branch already exists:\n${url}\n`
  const f = fixture([session("root", 50)], { root: [message(200, 300, [failed])] })
  try {
    await f.tracker.scan("root")
    expect(f.tracker.pulls("root")).toHaveLength(0)
  } finally { f.tracker.dispose() }
})

test("failed live gh creation does not save an existing PR", async () => {
  const f = fixture([session("root", 50)], {})
  try {
    f.emit("session.tool.input.started", { data: { id: "call", sessionID: "root", name: "shell" } })
    f.emit("session.tool.called", { created: 200, data: { id: "call", sessionID: "root", input: { command: "gh pr create --fill" } } })
    f.emit("session.tool.success", { data: { id: "call", sessionID: "root", metadata: { exit: 1 }, content: [{ type: "text", text: url }] } })
    await f.tracker.scan("root")
    expect(f.tracker.pulls("root")).toHaveLength(0)
  } finally { f.tracker.dispose() }
})

test("dismissed PRs and pages stay hidden after rescans and reopening", async () => {
  const sessions = [session("root", 50)]
  const messages = { root: [message(200, 300, [tool(), { type: "text", text: "http://localhost:3000/app" }])] }
  const f = fixture(sessions, messages)
  let reopened
  try {
    await f.tracker.scan("root")
    const pull = f.tracker.pulls("root")[0]
    const page = f.tracker.pages("root")[0]
    await f.tracker.dismiss("root", pull.key)
    await f.tracker.dismiss("root", page.url)
    await f.tracker.dismiss("root", page.url)
    expect(f.tracker.hasHidden("root")).toBe(true)
    expect(Object.keys(f.shared.get("hidden").byRoot.root)).toHaveLength(2)
    await f.tracker.scan("root")
    reopened = fixture(sessions, messages, new Map(structuredClone([...f.shared])))
    await reopened.tracker.scan("root")
    expect(reopened.tracker.pulls("root")).toEqual([])
    expect(reopened.tracker.pages("root")).toEqual([])
    expect(reopened.shared.get("chats").byRoot.root.pulls).toHaveLength(1)
    expect(reopened.shared.get("chats").byRoot.root.pages).toHaveLength(1)
    await reopened.tracker.restore("root")
    expect(reopened.tracker.hasHidden("root")).toBe(false)
    expect(reopened.tracker.pulls("root")).toEqual([pull])
    expect(reopened.tracker.pages("root")).toEqual([page])
  } finally { f.tracker.dispose(); reopened?.tracker.dispose() }
})

test("dismissal and restoration affect only their chat and exact link", async () => {
  const sessions = [session("first", 50), session("second", 50)]
  const content = [tool(), { type: "text", text: "http://localhost:3000/app http://localhost:3000/other" }]
  const f = fixture(sessions, { first: [message(200, 300, content)], second: [message(200, 300, content)] })
  try {
    await f.tracker.scan("first")
    await f.tracker.scan("second")
    await f.tracker.dismiss("first", f.tracker.pages("first")[0].url)
    await f.tracker.dismiss("second", f.tracker.pulls("second")[0].key)
    expect(f.tracker.pages("first").map((page) => page.url)).toEqual(["http://localhost:3000/other"])
    expect(f.tracker.pages("second")).toHaveLength(2)
    expect(f.tracker.pulls("first")).toHaveLength(1)
    await f.tracker.restore("first")
    expect(f.tracker.pages("first")).toHaveLength(2)
    expect(f.tracker.pulls("second")).toEqual([])
    expect(f.tracker.hasHidden("second")).toBe(true)
  } finally { f.tracker.dispose() }
})

test("new live mentions do not undo dismissal or hide other links", async () => {
  const f = fixture([session("root", 50)], { root: [message(200, 300, [tool(), { type: "text", text: "http://localhost:3000/app" }])] })
  try {
    await f.tracker.scan("root")
    await f.tracker.dismiss("root", f.tracker.pulls("root")[0].key)
    await f.tracker.dismiss("root", f.tracker.pages("root")[0].url)
    const created = f.nextWrite()
    f.emit("session.tool.input.started", { data: { id: "call", sessionID: "root", name: "shell" } })
    f.emit("session.tool.called", { created: 400, data: { id: "call", sessionID: "root", input: { command: "gh pr create --fill" } } })
    f.emit("session.tool.success", { data: { id: "call", sessionID: "root", metadata: { exit: 0 }, content: [{ type: "text", text: `${url}\n${url.replace("42", "43")}` }] } })
    await created
    const linked = f.nextWrite()
    f.emit("session.text.ended", { created: 500, data: { sessionID: "root", text: "http://localhost:3000/app http://localhost:4000" } })
    await linked
    expect(f.tracker.pulls("root").map((pull) => pull.number)).toEqual([43])
    expect(f.tracker.pages("root").map((page) => page.url)).toEqual(["http://localhost:4000"])
  } finally { f.tracker.dispose() }
})

test("a second window's pending scan cannot overwrite dismissal or restoration", async () => {
  const sessions = [session("root", 50)]
  const messages = { root: [message(200, 300, [tool()])] }
  const a = fixture(sessions, messages)
  const b = fixture(sessions, messages, a.shared)
  const entered = deferred()
  const released = deferred()
  const list = b.context.client.message.list
  b.context.client.message.list = async (input) => {
    const result = await list(input)
    entered.resolve()
    await released.promise
    return result
  }
  try {
    await a.tracker.scan("root")
    const scan = b.tracker.scan("root")
    await entered.promise
    await a.tracker.dismiss("root", a.tracker.pulls("root")[0].key)
    expect(b.tracker.pulls("root")).toEqual([])
    released.resolve()
    await scan
    expect(a.tracker.pulls("root")).toEqual([])
    await b.tracker.restore("root")
    expect(a.tracker.hasHidden("root")).toBe(false)
    expect(a.tracker.pulls("root")).toHaveLength(1)
  } finally { released.resolve(); a.tracker.dispose(); b.tracker.dispose() }
})

test("dismissals survive eviction of the chat history cache", async () => {
  const sessions = [session("root", 50), session("other", 50)]
  const messages = { root: [message(200, 300, [tool()])] }
  const f = fixture(sessions, messages)
  try {
    await f.tracker.scan("root")
    await f.tracker.dismiss("root", f.tracker.pulls("root")[0].key)
    f.shared.get("chats").byRoot.root.touched = 0
    await f.tracker.scan("other")
    expect(f.shared.get("chats").byRoot.root).toBeUndefined()
    await f.tracker.scan("root")
    expect(f.tracker.pulls("root")).toEqual([])
    await f.tracker.restore("root")
    expect(f.tracker.pulls("root")).toHaveLength(1)
  } finally { f.tracker.dispose() }
})

function extraCollector(version = 1) {
  const saved = new Map()
  return {
    saved,
    version,
    assistant: (message) => message.type === "assistant" ? message.content.flatMap((part) => part.type === "text" ? [part.text] : []) : [],
    user: (text) => [text],
    tool: (command, output, exit) => exit === 0 && command.startsWith("linear ") ? [output] : [],
    async save(rootID, found) { saved.set(rootID, [...new Set([...(saved.get(rootID) ?? []), ...found])]) },
  }
}

test("a new detector backfills settled legacy sessions once without resetting PR marks", async () => {
  const root = session("root", 100)
  root.time.idle = 500
  const child = session("child", 100, "root")
  child.time.idle = 500
  const shared = new Map([["chats", { byRoot: { root: {
    pulls: [], checkpoints: { root: { mark: 400, idle: 500 }, child: { mark: 400, idle: 500 } }, touched: Date.now(),
  } } }]])
  const extension = extraCollector()
  const f = fixture([root, child], {
    root: [message(200, 300, [{ type: "text", text: "root work" }]), { type: "user", time: { created: 100 }, text: "requested" }],
    child: [message(200, 300, [{ type: "text", text: "child work" }]), { type: "user", time: { created: 100 }, text: "child brief" }],
  }, shared, extension)
  try {
    expect(await f.tracker.scan("root")).toBe(true)
    expect(extension.saved.get("root").sort()).toEqual(["child work", "requested", "root work"])
    expect(shared.get("chats").byRoot.root.checkpoints.root.mark).toBe(400)
    expect(shared.get("chats").byRoot.root.checkpoints.root.extraMark).toBe(200)
    const before = f.calls.length
    await f.tracker.scan("root")
    expect(f.calls).toHaveLength(before)
  } finally { f.tracker.dispose() }
})

test("successful chunks survive another child's permanent read failure", async () => {
  const root = session("root", 100)
  root.time.idle = 500
  const good = session("good", 100, "root")
  good.time.idle = 500
  const bad = session("bad", 100, "root")
  bad.time.idle = 500
  const f = fixture([root, good, bad], { good: [message(200, 300, [tool()])] })
  const list = f.context.client.message.list
  let failures = 0
  f.context.client.message.list = (input) => {
    if (input.sessionID === "bad") { failures++; throw new Error("Broken migrated message") }
    return list(input)
  }
  try {
    expect(await f.tracker.scan("root")).toBe(false)
    expect(f.tracker.pulls("root")).toHaveLength(1)
    expect(f.shared.get("chats").byRoot.root.checkpoints.good.mark).toBe(200)
    const before = f.calls.length
    expect(await f.tracker.scan("root")).toBe(false)
    expect(f.calls).toHaveLength(before)
    expect(failures).toBe(2)
  } finally { f.tracker.dispose() }
})

test("extension events associate child actions but never child user briefs", async () => {
  const extension = extraCollector()
  const f = fixture([session("root", 100), session("child", 100, "root")], {}, new Map(), extension)
  try {
    f.emit("session.inbox.enqueued", { created: 200, data: { sessionID: "child", item: { type: "user", payload: { text: "child brief" } } } })
    f.emit("session.inbox.enqueued", { created: 200, data: { sessionID: "root", item: { type: "user", payload: { text: "human task" } } } })
    f.emit("session.tool.input.started", { data: { id: "call", sessionID: "child", name: "shell" } })
    f.emit("session.tool.called", { created: 200, data: { id: "call", sessionID: "child", input: { command: "linear issue create" } } })
    f.emit("session.tool.success", { data: { id: "call", sessionID: "child", metadata: { exit: 0 }, content: [{ type: "text", text: "created" }] } })
    await f.tracker.scan("root")
    expect(extension.saved.get("root").sort()).toEqual(["created", "human task"])
    expect(extension.saved.has("child")).toBe(false)
  } finally { f.tracker.dispose() }
})

test("a detector version change replays root requests without changing stable links", async () => {
  const root = session("root", 100)
  root.time.idle = 500
  const shared = new Map()
  const messages = { root: [message(200, 300, [tool()]), { type: "user", time: { created: 100 }, text: "human task" }] }
  const a = fixture([root], messages, shared, extraCollector(1))
  const next = extraCollector(2)
  const b = fixture([root], messages, shared, next)
  try {
    await a.tracker.scan("root")
    await b.tracker.scan("root")
    expect(next.saved.get("root")).toEqual(["human task"])
    expect(shared.get("chats").byRoot.root.userCheckpoint.version).toBe(2)
    expect(b.tracker.pulls("root")).toHaveLength(1)
    const before = b.calls.length
    await b.tracker.scan("root")
    expect(b.calls).toHaveLength(before)
  } finally { a.tracker.dispose(); b.tracker.dispose() }
})

test("root-user pagination never combines a cursor with order", async () => {
  const root = session("root", 1)
  root.time.idle = 500
  const extension = extraCollector()
  const f = fixture([root], {}, new Map(), extension)
  const list = f.context.client.message.list
  f.context.client.message.list = async (input) => {
    if (input.type !== "user") return list(input)
    if (input.cursor && input.order) throw new Error("Cursor cannot be combined with order")
    return input.cursor
      ? { data: [{ type: "user", time: { created: 100 }, text: "older task" }], cursor: {} }
      : { data: [{ type: "user", time: { created: 200 }, text: "newer task" }], cursor: { next: "older" } }
  }
  try {
    expect(await f.tracker.scan("root")).toBe(true)
    expect(extension.saved.get("root")).toEqual(["newer task", "older task"])
    expect(f.shared.get("chats").byRoot.root.userCheckpoint.mark).toBe(200)
  } finally { f.tracker.dispose() }
})

test("blur or unmount aborts history requests without starting more children", async () => {
  const sessions = [session("root", 1), ...Array.from({ length: 12 }, (_, index) => session(`child-${index}`, 1, "root"))]
  const f = fixture(sessions, {})
  const controller = new AbortController()
  const entered = deferred()
  let requests = 0
  const list = f.context.client.message.list
  f.context.client.message.list = (input, { signal }) => {
    if (input.type === "user") return Promise.resolve({ data: [], cursor: {} })
    requests++
    if (requests === 4) entered.resolve()
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true })
    })
  }
  try {
    const pending = f.tracker.scan("root", controller.signal)
    await entered.promise
    controller.abort()
    expect(await pending).toBe(false)
    expect(requests).toBe(4)
    expect(f.shared.get("chats").byRoot.root?.checkpoints ?? {}).toEqual({})
    f.context.client.message.list = list
    expect(await f.tracker.scan("root")).toBe(true)
  } finally { controller.abort(); f.tracker.dispose() }
})

test("visiting a settled chat refreshes retention without rereading messages", async () => {
  const root = session("root", 1)
  root.time.idle = 500
  const f = fixture([root, session("other", 1)], { root: [message(200, 300, [tool()])] })
  try {
    await f.tracker.scan("root")
    f.shared.get("chats").byRoot.root.touched = 0
    const before = f.calls.length
    await f.tracker.scan("root")
    expect(f.calls).toHaveLength(before)
    await f.tracker.scan("other")
    expect(f.tracker.pulls("root")).toHaveLength(1)
  } finally { f.tracker.dispose() }
})

test("reenabling an extension catches work from the disabled period", async () => {
  const root = session("root", 1)
  root.time.idle = 300
  const messages = { root: [message(100, 200, [{ type: "text", text: "first work" }])] }
  const shared = new Map()
  const active = extraCollector()
  const a = fixture([root], messages, shared, active)
  const disabled = fixture([root], messages, shared)
  const resumed = extraCollector()
  const b = fixture([root], messages, shared, resumed)
  try {
    await a.tracker.scan("root")
    root.time.updated = 400
    root.time.idle = 600
    messages.root = [message(500, 550, [{ type: "text", text: "work while disabled" }]), ...messages.root]
    await disabled.tracker.scan("root")
    expect(shared.get("chats").byRoot.root.checkpoints.root.idle).toBe(600)
    expect(shared.get("chats").byRoot.root.checkpoints.root.extraIdle).toBe(300)
    await b.tracker.scan("root")
    expect(resumed.saved.get("root")).toContain("work while disabled")
    expect(shared.get("chats").byRoot.root.checkpoints.root.extraIdle).toBe(600)
  } finally { a.tracker.dispose(); disabled.tracker.dispose(); b.tracker.dispose() }
})

test("older detector stamps cannot make newer user history look fully covered", async () => {
  const root = session("root", 1)
  root.time.idle = 300
  const messages = { root: [{ type: "user", time: { created: 100 }, text: "first task" }] }
  const shared = new Map()
  const next = extraCollector(2)
  const a = fixture([root], messages, shared, next)
  const b = fixture([root], messages, shared, extraCollector(1))
  const entered = deferred()
  const release = deferred()
  const list = a.context.client.message.list
  a.context.client.message.list = async (input) => {
    const snapshot = await list(input)
    if (input.type === "user") { entered.resolve(); await release.promise }
    return snapshot
  }
  try {
    const pending = a.tracker.scan("root")
    await entered.promise
    root.time.updated = 400
    root.time.idle = 600
    messages.root = [{ type: "user", time: { created: 500 }, text: "new task" }, ...messages.root]
    await b.tracker.scan("root")
    release.resolve()
    await pending
    expect(shared.get("chats").byRoot.root.userCheckpoint).toMatchObject({ version: 2, mark: 100, idle: 300 })
    await a.tracker.scan("root")
    expect(next.saved.get("root")).toContain("new task")
  } finally { release.resolve(); a.tracker.dispose(); b.tracker.dispose() }
})

test("page detector backfill replays only root replies once without resetting other checkpoints", async () => {
  const root = session("root", 400)
  root.time.idle = 500
  const child = session("child", 400, "root")
  child.time.idle = 500
  const checkpoint = { mark: 400, idle: 500, pullsVersion: 4, extraMark: 400, extraIdle: 500, version: 2 }
  const existing = { key: "github.com/acme/web#42", url, host: "github.com", owner: "acme", repo: "web", number: 42, created: 200 }
  const shared = new Map([["chats", { byRoot: { root: {
    pulls: [existing], pages: [], checkpoints: { root: { ...checkpoint, pagesVersion: 1 }, child: { ...checkpoint } },
    userCheckpoint: { mark: 400, idle: 500, version: 2 }, pullsUserCheckpoint: { mark: 400, idle: 500, version: 1 }, touched: Date.now(),
  } } }], ["hidden", { byRoot: { root: { [existing.key]: true, "https://hidden.shop.localhost": true } } }]])
  const extension = extraCollector(2)
  const f = fixture([root, child], {
    root: [message(200, 300, [tool(43), { type: "text", text: "https://icons.shop.localhost https://hidden.shop.localhost" }])],
    child: [message(200, 300, [{ type: "text", text: "https://child.shop.localhost" }])],
  }, shared, extension)
  try {
    expect(await f.tracker.scan("root")).toBe(true)
    expect(f.tracker.pages("root").map((page) => page.url)).toEqual(["https://icons.shop.localhost"])
    expect(f.calls).toEqual(["root"])
    expect(extension.saved.get("root")).toEqual([])
    expect(shared.get("chats").byRoot.root.checkpoints.root).toMatchObject({ ...checkpoint, pagesVersion: 4 })
    expect(shared.get("chats").byRoot.root.checkpoints.child).toEqual(checkpoint)
    expect(shared.get("chats").byRoot.root.userCheckpoint).toEqual({ mark: 400, idle: 500, version: 2 })
    expect(shared.get("chats").byRoot.root.pulls).toEqual([existing])
    expect(f.tracker.pulls("root")).toEqual([])
    expect(await f.tracker.scan("root")).toBe(true)
    expect(f.calls).toEqual(["root"])
  } finally { f.tracker.dispose() }
})

test("a failed page backfill retries from the beginning without certifying incomplete history", async () => {
  const root = session("root", 400)
  root.time.idle = 500
  const shared = new Map([["chats", { byRoot: { root: {
    pulls: [], pages: [], checkpoints: { root: { mark: 400, idle: 500, pullsVersion: 4 } }, pullsUserCheckpoint: { mark: 400, idle: 500, version: 1 }, touched: Date.now(),
  } } }]])
  const f = fixture([root], {}, shared)
  let fail = true
  const inputs = []
  f.context.client.message.list = async (input) => {
    inputs.push(input)
    if (input.cursor) {
      if (fail) throw new Error("History disconnected")
      return { data: [message(100, 150, [{ type: "text", text: "https://older.shop.localhost" }])], cursor: {} }
    }
    return { data: [message(200, 300, [{ type: "text", text: "https://newer.shop.localhost" }])], cursor: { next: "older" } }
  }
  try {
    expect(await f.tracker.scan("root")).toBe(false)
    expect(shared.get("chats").byRoot.root.checkpoints.root.pagesVersion).toBeUndefined()
    expect(f.tracker.pages("root")).toEqual([])
    fail = false
    expect(await f.tracker.scan("root")).toBe(true)
    expect(f.tracker.pages("root").map((page) => page.url)).toEqual(["https://newer.shop.localhost", "https://older.shop.localhost"])
    expect(shared.get("chats").byRoot.root.checkpoints.root).toMatchObject({ mark: 400, idle: 500, pagesVersion: 4 })
    expect(inputs.map((input) => input.cursor)).toEqual([undefined, "older", undefined, "older"])
    expect(inputs.filter((input) => input.cursor).every((input) => input.order === undefined)).toBe(true)
  } finally { f.tracker.dispose() }
})

test("an aborted page backfill is retried on the next focused scan", async () => {
  const root = session("root", 400)
  root.time.idle = 500
  const f = fixture([root], { root: [message(200, 300, [{ type: "text", text: "https://icons.shop.localhost" }])] }, new Map([["chats", { byRoot: { root: {
    pulls: [], pages: [], checkpoints: { root: { mark: 400, idle: 500, pullsVersion: 4 } }, pullsUserCheckpoint: { mark: 400, idle: 500, version: 1 }, touched: Date.now(),
  } } }]]))
  const controller = new AbortController()
  const entered = deferred()
  const list = f.context.client.message.list
  f.context.client.message.list = (_input, { signal }) => {
    entered.resolve()
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true }))
  }
  try {
    const pending = f.tracker.scan("root", controller.signal)
    await entered.promise
    controller.abort()
    expect(await pending).toBe(false)
    expect(f.shared.get("chats").byRoot.root.checkpoints.root.pagesVersion).toBeUndefined()
    f.context.client.message.list = list
    expect(await f.tracker.scan("root")).toBe(true)
    expect(f.tracker.pages("root").map((page) => page.url)).toEqual(["https://icons.shop.localhost"])
  } finally { controller.abort(); f.tracker.dispose() }
})

test("page repair keeps legacy dismissals hidden without changing their stored keys", async () => {
  const root = session("root", 400)
  root.time.idle = 500
  const bad = "http://localhost:3194/lab/glyphs**"
  const clean = "http://localhost:3194/lab/glyphs"
  const oldPage = { url: bad, origin: "http://localhost:3194", label: "localhost:3194/lab/glyphs**", created: 200 }
  const shared = new Map([["chats", { byRoot: { root: {
    pulls: [], pages: [oldPage], checkpoints: { root: { mark: 400, idle: 500, pullsVersion: 4 } }, pullsUserCheckpoint: { mark: 400, idle: 500, version: 1 }, touched: Date.now(),
  } } }], ["hidden", { byRoot: { root: { [bad]: true } } }]])
  const f = fixture([root], { root: [message(200, 300, [{ type: "text", text: "**http://localhost:3194/lab/glyphs**" }])] }, shared)
  let reopened
  try {
    expect(await f.tracker.scan("root")).toBe(true)
    expect(f.tracker.pages("root")).toEqual([])
    expect(shared.get("chats").byRoot.root.pages).toHaveLength(1)
    expect(shared.get("chats").byRoot.root.pages[0]).toMatchObject({ url: clean, aliases: [bad] })
    expect(shared.get("hidden").byRoot.root).toEqual({ [bad]: true })
    reopened = fixture([root], {}, new Map(structuredClone([...shared])))
    expect(reopened.tracker.pages("root")).toEqual([])
    await reopened.tracker.restore("root")
    expect(reopened.tracker.pages("root").map((page) => page.url)).toEqual([clean])
    await reopened.tracker.dismiss("root", clean)
    expect(reopened.tracker.pages("root")).toEqual([])
  } finally { f.tracker.dispose(); reopened?.tracker.dispose() }
})

test("live bold local pages persist in the root chat but never from child replies", async () => {
  const f = fixture([session("root", 400), session("child", 400, "root")], {})
  const clean = "https://web-2194-toolbar-icons.shop.localhost"
  try {
    const written = f.nextWrite()
    f.emit("session.text.ended", { created: 500, data: { sessionID: "root", text: `**${clean}**` } })
    await written
    expect(f.tracker.pages("root").map((page) => page.url)).toEqual([clean])
    f.emit("session.text.ended", { created: 501, data: { sessionID: "child", text: "**https://child.shop.localhost**" } })
    await Bun.sleep(0)
    expect(f.tracker.pages("root").map((page) => page.url)).toEqual([clean])
    expect(f.tracker.pages("child")).toEqual([])
    expect(f.calls).toEqual([])
  } finally { f.tracker.dispose() }
})

test("a user-only detector upgrade replays requests without rereading assistant or child history", async () => {
  const root = session("root", 400)
  root.time.idle = 500
  const child = session("child", 400, "root")
  child.time.idle = 500
  const checkpoint = { mark: 400, idle: 500, pullsVersion: 4, extraMark: 400, extraIdle: 500, version: 2 }
  const shared = new Map([["chats", { byRoot: { root: {
    pulls: [], pages: [], checkpoints: { root: { ...checkpoint, pagesVersion: 4 }, child: { ...checkpoint } },
    userCheckpoint: { mark: 400, idle: 500, version: 2 }, pullsUserCheckpoint: { mark: 400, idle: 500, version: 1 }, touched: Date.now(),
  } } }]])
  const extension = { ...extraCollector(2), userVersion: 3 }
  const f = fixture([root, child], {
    root: [{ type: "user", time: { created: 200 }, text: "requested targets" }, message(200, 300, [{ type: "text", text: "assistant context" }])],
    child: [{ type: "user", time: { created: 200 }, text: "child brief" }],
  }, shared, extension)
  const reads = []
  const list = f.context.client.message.list
  f.context.client.message.list = (input) => { reads.push({ sessionID: input.sessionID, type: input.type }); return list(input) }
  try {
    expect(await f.tracker.scan("root")).toBe(true)
    expect(extension.saved.get("root")).toEqual(["requested targets"])
    expect(reads).toEqual([{ sessionID: "root", type: "user" }])
    expect(shared.get("chats").byRoot.root.checkpoints.root).toEqual({ ...checkpoint, pagesVersion: 4 })
    expect(shared.get("chats").byRoot.root.checkpoints.child).toEqual(checkpoint)
    expect(shared.get("chats").byRoot.root.userCheckpoint).toEqual({ mark: 200, idle: 500, version: 3 })
    expect(await f.tracker.scan("root")).toBe(true)
    expect(reads).toHaveLength(1)
  } finally { f.tracker.dispose() }
})

test("failed user-only backfills do not advance their detector stamp", async () => {
  const root = session("root", 400)
  root.time.idle = 500
  const f = fixture([root], { root: [{ type: "user", time: { created: 200 }, text: "requested targets" }] }, new Map([["chats", { byRoot: { root: {
    pulls: [], pages: [], checkpoints: { root: { mark: 400, idle: 500, pullsVersion: 4, pagesVersion: 4, version: 2, extraMark: 400, extraIdle: 500 } },
    userCheckpoint: { mark: 400, idle: 500, version: 2 }, pullsUserCheckpoint: { mark: 400, idle: 500, version: 1 }, touched: Date.now(),
  } } }]]), { ...extraCollector(2), userVersion: 3 })
  const list = f.context.client.message.list
  f.context.client.message.list = () => { throw new Error("History unavailable") }
  try {
    expect(await f.tracker.scan("root")).toBe(false)
    expect(f.shared.get("chats").byRoot.root.userCheckpoint).toEqual({ mark: 400, idle: 500, version: 2 })
    f.context.client.message.list = list
    expect(await f.tracker.scan("root")).toBe(true)
    expect(f.shared.get("chats").byRoot.root.userCheckpoint).toEqual({ mark: 200, idle: 500, version: 3 })
  } finally { f.tracker.dispose() }
})

const shell = (command, text, exit = 0, created = 210) => ({
  type: "tool", name: "shell", time: { created },
  state: { status: "completed", input: { command }, metadata: { exit }, content: [{ type: "text", text }] },
})
const banner = "  -> https://web-1.shop.localhost\n- Local:         http://localhost:4795\n"

test("history adds worked and monitored PRs, root server banners and root-user PR links", async () => {
  const root = session("root", 400)
  const child = session("child", 400, "root")
  const f = fixture([root, child], {
    root: [
      { type: "user", time: { created: 100 }, text: "check https://github.com/acme/backend/pull/867 please" },
      message(200, 300, [shell("tail -20 /tmp/dev.log", banner), shell("gh pr checks 733 -R acme/backend", "ci pass")]),
      message(100, 150, [shell("pnpm dev > /tmp/dev.log 2>&1 &", "")]),
    ],
    child: [
      { type: "user", time: { created: 150 }, text: "brief mentions https://github.com/acme/web/pull/1" },
      message(200, 300, [shell("gh pr merge 32 -R acme/components --squash", ""), shell("tail /tmp/child.log", "- Local:   http://localhost:5000")]),
    ],
  })
  try {
    expect(await f.tracker.scan("root")).toBe(true)
    expect(f.tracker.pulls("root").map((pull) => pull.key).sort()).toEqual([
      "github.com/acme/backend#733", "github.com/acme/backend#867", "github.com/acme/components#32",
    ])
    expect(f.tracker.pages("root").map((page) => page.url)).toEqual(["https://web-1.shop.localhost", "http://localhost:4795"])
  } finally { f.tracker.dispose() }
})

test("widened detectors backfill settled chats once and keep dismissals", async () => {
  const root = session("root", 400)
  root.time.idle = 500
  const child = session("child", 400, "root")
  child.time.idle = 500
  const seeded = { mark: 400, idle: 500 }
  const shared = new Map([["chats", { byRoot: { root: {
    pulls: [], pages: [], checkpoints: { root: { ...seeded, pagesVersion: 2 }, child: { ...seeded } }, touched: Date.now(),
  } } }], ["hidden", { byRoot: { root: { "github.com/acme/web#5": true } } }]])
  const f = fixture([root, child], {
    root: [{ type: "user", time: { created: 100 }, text: "https://github.com/acme/web/pull/5" }, message(200, 300, [shell("pnpm dev > /tmp/dev.log 2>&1 &", ""), shell("cat /tmp/dev.log", banner)])],
    child: [message(200, 300, [shell("gh pr ready 9 -R acme/web", "")])],
  }, shared)
  try {
    expect(await f.tracker.scan("root")).toBe(true)
    expect(f.tracker.pulls("root").map((pull) => pull.key)).toEqual(["github.com/acme/web#9"])
    expect(shared.get("chats").byRoot.root.pulls.map((pull) => pull.key).sort()).toEqual(["github.com/acme/web#5", "github.com/acme/web#9"])
    expect(f.tracker.pages("root").map((page) => page.url)).toEqual(["https://web-1.shop.localhost", "http://localhost:4795"])
    expect(shared.get("chats").byRoot.root.checkpoints.child).toEqual({ ...seeded, pullsVersion: 4 })
    expect(shared.get("chats").byRoot.root.pullsUserCheckpoint).toEqual({ mark: 100, idle: 500, version: 1 })
    const before = f.calls.length
    expect(await f.tracker.scan("root")).toBe(true)
    expect(f.calls).toHaveLength(before)
  } finally { f.tracker.dispose() }
})

test("live work, monitoring, banners and pasted PRs persist in the root chat", async () => {
  const f = fixture([session("root", 400), session("child", 400, "root")], {})
  const run = (id, sessionID, name, input, text, exit = 0) => {
    f.emit("session.tool.input.started", { data: { id, sessionID, name } })
    f.emit("session.tool.called", { created: 300, data: { id, sessionID, input } })
    f.emit("session.tool.success", { data: { id, sessionID, metadata: { exit }, content: [{ type: "text", text }] } })
  }
  try {
    run("a", "child", "shell", { command: "gh pr checks 9 -R acme/web" }, "build pass", 8)
    run("b", "child", "shell", { command: "tail /tmp/child.log" }, "- Local:   http://localhost:5000")
    run("s", "root", "shell", { command: "pnpm dev > /tmp/dev.log 2>&1 &" }, "")
    run("o", "root", "read", { path: "/tmp/other.log" }, "1: - Local:   http://localhost:4001")
    for (let index = 0; index < 20; index++) await Bun.sleep(0)
    run("c", "root", "read", { path: "/tmp/dev.log" }, "1: - Local:   http://localhost:4000")
    run("d", "root", "shell", { command: "true || gh pr create; echo https://github.com/acme/web/pull/1" }, "https://github.com/acme/web/pull/1", 1)
    f.emit("session.inbox.enqueued", { created: 400, data: { sessionID: "root", item: { type: "user", payload: { text: "https://github.com/acme/api/pull/3" } } } })
    f.emit("session.inbox.enqueued", { created: 401, data: { sessionID: "child", item: { type: "user", payload: { text: "https://github.com/acme/api/pull/4" } } } })
    for (let index = 0; index < 20; index++) await Bun.sleep(0)
    expect(f.tracker.pulls("root").map((pull) => pull.key).sort()).toEqual(["github.com/acme/api#3", "github.com/acme/web#9"])
    expect(f.tracker.pages("root").map((page) => page.url)).toEqual(["http://localhost:4000"])
    expect(f.calls).toEqual([])
  } finally { f.tracker.dispose() }
})

const failedShell = (command, text = "", error = { type: "aborted", message: "Tool execution interrupted" }, metadata = { shellID: "sh_1" }) => ({
  type: "tool", name: "shell", time: { created: 210 },
  state: { status: "error", input: { command }, error, content: [{ type: "text", text }], ...(metadata ? { metadata } : {}) },
})

test("interrupted shell parts in history still count issued PR work, never creation or commands that never ran", async () => {
  const root = session("root", 400)
  root.time.idle = 500
  const seeded = { mark: 400, idle: 500, pullsVersion: 3 }
  const shared = new Map([["chats", { byRoot: { root: { pulls: [], pages: [], checkpoints: { root: { ...seeded, pagesVersion: 4 } }, touched: Date.now() } } }]])
  const f = fixture([root], {
    root: [message(200, 300, [
      failedShell("cd ~/web && gh pr merge 621 --repo acme/web --merge 2>&1 | tail -2; sleep 5; for i in $(seq 1 40); do gh api repos/acme/web/deployments; sleep 20; done"),
      failedShell("gh pr create --fill", url),
      failedShell("echo 'gh pr close 7 -R acme/web'"),
      failedShell("gh pr merge 77 -R acme/web --squash", "", { type: "permission.rejected", message: "Blocked by configuration policy" }, null),
      failedShell("gh pr close 78 -R acme/web", "", { type: "tool.execution", message: "Blocked by the shell-edit-guard plugin" }, null),
      failedShell("gh pr close 79 -R acme/web", "", { type: "aborted", message: "The user declined this tool call" }, null),
      failedShell("gh pr close 80 -R acme/web", "", { type: "aborted", message: "Tool execution interrupted: shell" }, null),
    ])],
  }, shared)
  try {
    expect(await f.tracker.scan("root")).toBe(true)
    expect(f.tracker.pulls("root").map((pull) => pull.key)).toEqual(["github.com/acme/web#621"])
    expect(shared.get("chats").byRoot.root.checkpoints.root.pullsVersion).toBe(4)
  } finally { f.tracker.dispose() }
})

test("failed live shell calls that ran record issued PR work in the root chat but never creation or unexecuted commands", async () => {
  const f = fixture([session("root", 400), session("child", 400, "root")], {})
  const fail = (id, command, text, launched = true) => {
    f.emit("session.tool.input.started", { data: { id, sessionID: "child", name: "shell" } })
    f.emit("session.tool.called", { created: 300, data: { id, sessionID: "child", input: { command } } })
    f.emit("session.tool.failed", { data: { id, sessionID: "child", error: { type: "aborted", message: "x" }, content: [{ type: "text", text }], executed: false, ...(launched ? { metadata: { shellID: `sh_${id}` } } : {}) } })
  }
  try {
    fail("a", "gh pr merge 32 -R acme/components --squash", "")
    fail("b", "gh pr create --fill", url)
    fail("c", "gh pr view 9 -R acme/web --json statusCheckRollup", "{}")
    fail("d", "gh pr merge 33 -R acme/components --squash", "", false)
    for (let index = 0; index < 20; index++) await Bun.sleep(0)
    expect(f.tracker.pulls("root").map((pull) => pull.key).sort()).toEqual(["github.com/acme/components#32", "github.com/acme/web#9"])
    expect(f.calls).toEqual([])
  } finally { f.tracker.dispose() }
})
