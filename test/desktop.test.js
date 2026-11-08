import { afterEach, beforeEach, expect, test } from "bun:test"
import { Exit, Schema } from "effect"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createLinks } from "../src/links.ts"
import { createController } from "../src/desktop/controller.ts"
import { mainHost } from "../src/desktop/host.ts"
import { importTuiCache, tuiDirectories } from "../src/desktop/import.ts"
import { viewOf } from "../src/desktop/view.ts"
import { Links } from "../src/desktop/contract.ts"

const url = "https://github.com/acme/web/pull/42"
const session = (id, updated, parentID) => ({ id, parentID, time: { created: 1, updated } })
const message = (created, completed, content = []) => ({ type: "assistant", time: { created, completed }, content })
const tool = () => ({
  type: "tool",
  name: "shell",
  time: { created: 210 },
  state: {
    status: "completed",
    input: { command: "gh pr create --fill" },
    metadata: { exit: 0 },
    content: [{ type: "text", text: url }],
  },
})
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

function storage(db = new Map()) {
  return {
    db,
    store(key, options) {
      const codec = Schema.toCodecJson(options.schema)
      let cached
      const read = () => {
        const json = db.get(key)
        if (cached && cached.json === json) return cached.value
        const exit = json === undefined ? undefined : Schema.decodeUnknownExit(Schema.fromJsonString(codec))(json)
        cached = { json, value: exit && Exit.isSuccess(exit) ? exit.value : options.initial }
        return cached.value
      }
      return {
        get value() { return read() },
        ready: () => true,
        update() { throw new Error("the main host replaces values with set") },
        set(next) { db.set(key, JSON.stringify(Schema.encodeSync(codec)(next))) },
      }
    },
  }
}

function client(sessions, messages) {
  const streams = []
  const calls = { get: 0, list: 0, subscribe: [] }
  return {
    calls,
    streams,
    session: {
      get: async ({ sessionID }) => {
        calls.get++
        const found = sessions.find((entry) => entry.id === sessionID)
        if (!found) throw new Error("Not found")
        return structuredClone(found)
      },
      list: async ({ parentID }) => ({ data: structuredClone(sessions.filter((entry) => entry.parentID === parentID)), cursor: {} }),
    },
    message: {
      list: async ({ sessionID, type }) => {
        calls.list++
        return { data: structuredClone((messages[sessionID] ?? []).filter((item) => !type || item.type === type)), cursor: {} }
      },
    },
    event: {
      subscribe({ types, signal }) {
        calls.subscribe.push(types)
        const queue = []
        let wake
        streams.push((event) => { queue.push(event); wake?.() })
        return (async function* () {
          while (!signal.aborted) {
            if (queue.length === 0) await new Promise((resolve) => {
              wake = resolve
              signal.addEventListener("abort", resolve, { once: true })
            })
            while (queue.length > 0) yield queue.shift()
          }
        })()
      },
    },
  }
}

function fixture({ sessions = [session("root", 50)], messages = {}, options = {}, db } = {}) {
  const store = storage(db)
  const api = client(sessions, messages)
  let changes = 0
  let listener = () => undefined
  const runtime = mainHost({ storage: store, client: () => api, changed: () => { changes++; listener() } })
  const links = createLinks(runtime.host, options)
  return {
    store, api, runtime, links,
    get changes() { return changes },
    control(wins, push) {
      const controller = createController({ links, windows: wins, push })
      listener = controller.changed
      return controller
    },
    dispose() { links.dispose(); runtime.dispose() },
  }
}

function windows() {
  const all = new Map()
  return {
    all,
    open(id, focused) {
      const listeners = { focus: new Set(), blur: new Set() }
      const win = {
        focused,
        isFocused: () => win.focused,
        on: (event, listener) => listeners[event].add(listener),
        off: (event, listener) => listeners[event].delete(listener),
        emit(event) {
          win.focused = event === "focus"
          listeners[event].forEach((listener) => listener())
        },
        listeners,
      }
      all.set(id, win)
      return win
    },
    get: (id) => all.get(id),
  }
}

let originalFetch
let probes
beforeEach(() => {
  originalFetch = globalThis.fetch
  probes = []
  globalThis.fetch = async (target, init) => {
    probes.push({ target: String(target), signal: init?.signal })
    return new Response(null, { status: 200 })
  }
})
afterEach(() => { globalThis.fetch = originalFetch })

test("the shared core scans, persists and hides through a framework-free host", async () => {
  const f = fixture({ messages: { root: [message(200, 300, [tool(), { type: "text", text: "Open http://localhost:3000/app" }])] } })
  try {
    expect(await f.links.tracker.scan("root")).toBe(true)
    expect(f.links.pulls("root").map((pull) => pull.number)).toEqual([42])
    expect(f.links.pages("root").map((page) => page.url)).toEqual(["http://localhost:3000/app"])
    expect(f.changes).toBeGreaterThan(0)
    expect(JSON.parse(f.store.db.get("chats")).byRoot.root.pulls).toHaveLength(1)
    await f.links.tracker.dismiss("root", "http://localhost:3000/app")
    expect(f.links.pages("root")).toEqual([])
    expect(f.links.tracker.hasHidden("root")).toBe(true)
    await f.links.tracker.restore("root")
    expect(f.links.pages("root")).toHaveLength(1)
  } finally { f.dispose() }
})

test("main storage keeps optional checkpoint fields across reopening", async () => {
  const db = new Map()
  const a = fixture({ db, messages: { root: [message(200, undefined, [tool()])] } })
  try {
    await a.links.tracker.scan("root")
    const stored = JSON.parse(db.get("chats")).byRoot.root.checkpoints.root
    expect(stored.mark).toBe(199)
  } finally { a.dispose() }
  const b = fixture({ db })
  try {
    expect(b.links.pulls("root").map((pull) => pull.key)).toEqual(["github.com/acme/web#42"])
    expect(b.store.store("chats", { schema: Schema.Unknown, initial: {} }).value).toBeDefined()
  } finally { b.dispose() }
})

test("live events from the main stream persist links without network reads", async () => {
  const f = fixture({ sessions: [session("root", 50), session("child", 60, "root")] })
  try {
    f.runtime.start()
    expect(f.api.calls.subscribe).toHaveLength(1)
    expect(f.api.calls.subscribe[0]).toContain("session.tool.success")
    expect(f.api.calls.subscribe[0]).not.toContain("server.connected")
    const send = f.api.streams[0]
    send({ type: "session.tool.input.started", data: { id: "call", sessionID: "child", name: "shell" } })
    send({ type: "session.tool.called", created: 200, data: { id: "call", sessionID: "child", input: { command: "gh pr create --fill" } } })
    send({ type: "session.tool.success", data: { id: "call", sessionID: "child", metadata: { exit: 0 }, content: [{ type: "text", text: url }] } })
    await tick(10)
    expect(f.links.pulls("root")).toHaveLength(1)
    send({ type: "session.text.ended", created: 250, data: { sessionID: "child", text: "Open http://localhost:3000" } })
    send({ type: "session.text.ended", created: 260, data: { sessionID: "root", text: "Open http://localhost:4000" } })
    await tick(10)
    expect(f.links.pages("root").map((page) => page.url)).toEqual(["http://localhost:4000"])
    expect(f.api.calls.get).toBe(2)
    expect(f.api.calls.list).toBe(0)
    expect(probes).toHaveLength(0)
  } finally { f.dispose() }
})

test("a live gh pr merge in Desktop main marks the chat's PR dirty in main storage", async () => {
  const db = new Map([["chats", JSON.stringify({ byRoot: { root: { pulls: [{ key: "github.com/acme/web#42", url, host: "github.com", owner: "acme", repo: "web", number: 42, created: 1 }], touched: Date.now() } } })]])
  const f = fixture({ sessions: [session("root", 50), session("child", 60, "root")], db })
  try {
    f.runtime.start()
    const send = f.api.streams[0]
    send({ type: "session.tool.input.started", data: { id: "merge", sessionID: "child", name: "shell" } })
    send({ type: "session.tool.called", created: 200, data: { id: "merge", sessionID: "child", input: { command: "gh pr merge 42 --squash" } } })
    const before = Date.now()
    send({ type: "session.tool.success", data: { id: "merge", sessionID: "child", metadata: { exit: 0 }, content: [] } })
    await tick(10)
    const stored = JSON.parse(f.store.db.get("refresh.github"))
    expect(stored.dirty["github.com/acme/web#42"]).toHaveLength(1)
    expect(stored.rechecks["github.com/acme/web#42"]).toHaveLength(4)
    expect(stored.dirty["github.com/acme/web#42"][0]).toBeGreaterThanOrEqual(before)
    expect(f.links.tracker.due(f.links.pulls("root"))).toBeLessThanOrEqual(Date.now())
  } finally { f.dispose() }
})

test("the view model is display-ready and matches the Ipc schema", async () => {
  const f = fixture({ messages: { root: [message(200, 300, [tool(), { type: "text", text: "http://localhost:3000" }])] } })
  try {
    await f.links.tracker.scan("root")
    await f.links.tracker.check(["http://localhost:3000"])
    const view = viewOf(f.links, "root")
    expect(view).toEqual({
      rootID: "root", linear: false, issues: [], hidden: false, issueHint: undefined, pullHint: undefined,
      pulls: [{ key: "github.com/acme/web#42", number: 42, repo: "web", title: "", url, state: "unknown" }],
      pages: [{ key: "http://localhost:3000", url: "http://localhost:3000", label: "localhost:3000", down: false }],
    })
    const state = { views: { root: view } }
    expect(Schema.decodeUnknownSync(Links.spec.state)(Schema.encodeSync(Links.spec.state)(state))).toEqual(state)
  } finally { f.dispose() }
})

test("windows watch sessions by root and only focused active watchers touch the network", async () => {
  const sessions = [session("root", 50), session("child", 60, "root")]
  const db = new Map([["chats", JSON.stringify({ byRoot: { root: { pulls: [], pages: [{ url: "http://localhost:3000", origin: "http://localhost:3000", label: "localhost:3000", created: 1 }], touched: Date.now() } } })]])
  const f = fixture({ sessions, db })
  const wins = windows()
  const first = wins.open(1, false)
  wins.open(2, true)
  const pushed = []
  const controller = f.control(wins, (window) => pushed.push(window))
  try {
    await controller.watch(1, [{ sessionID: "child", active: true }])
    expect(controller.state(1).views.child.rootID).toBe("root")
    expect(controller.state(1).views.child.pages).toHaveLength(1)
    expect(pushed).toContain(1)
    await tick(10)
    expect(f.api.calls.list).toBe(0)
    expect(probes).toHaveLength(0)

    await controller.watch(2, [{ sessionID: "root", active: false }])
    await tick(10)
    expect(controller.state(2).views.root.rootID).toBe("root")
    expect(probes).toHaveLength(0)

    first.emit("focus")
    await tick(10)
    expect(probes.map((probe) => probe.target)).toEqual(["http://localhost:3000"])

    first.emit("blur")
    expect(probes[0].signal.aborted).toBe(true)

    controller.close(1)
    expect(first.listeners.focus.size).toBe(0)
    expect(controller.state(1).views).toEqual({})
  } finally { controller.dispose(); f.dispose() }
})

test("a newly focused watcher catches up history once and pushes changes to windows", async () => {
  const f = fixture({ messages: { root: [message(200, 300, [tool()])] } })
  const wins = windows()
  wins.open(1, true)
  const pushed = []
  const controller = f.control(wins, (window) => pushed.push(window))
  try {
    await controller.watch(1, [{ sessionID: "root", active: true }])
    await tick(80)
    expect(controller.state(1).views.root.pulls.map((pull) => pull.number)).toEqual([42])
    expect(pushed).toContain(undefined)
  } finally { controller.dispose(); f.dispose() }
})

test("a failed root lookup retries on reconnect and window focus, and stops after close and dispose", async () => {
  const sessions = []
  const f = fixture({ sessions })
  const wins = windows()
  const win = wins.open(1, true)
  const pushed = []
  const controller = f.control(wins, (window) => pushed.push(window))
  try {
    f.runtime.start()
    await controller.watch(1, [{ sessionID: "root", active: true }])
    expect(controller.state(1).views).toEqual({})
    expect(f.api.calls.get).toBe(1)

    f.api.streams[0]({ type: "server.connected", data: {} })
    await tick(10)
    expect(f.api.calls.get).toBe(2)
    expect(controller.state(1).views).toEqual({})

    sessions.push(session("root", 50))
    f.api.streams[0]({ type: "server.connected", data: {} })
    await tick(10)
    expect(controller.state(1).views.root.rootID).toBe("root")
    expect(pushed.at(-1)).toBe(1)

    await controller.watch(1, [{ sessionID: "gone", active: true }])
    await tick(10)
    const gets = f.api.calls.get
    win.emit("blur")
    win.emit("focus")
    await tick(10)
    expect(f.api.calls.get).toBe(gets + 1)

    controller.close(1)
    f.api.streams[0]({ type: "server.connected", data: {} })
    await tick(10)
    expect(f.api.calls.get).toBe(gets + 1)

    await controller.watch(2, [{ sessionID: "gone", active: true }])
    expect(f.api.calls.get).toBe(gets + 2)
    controller.dispose()
    f.api.streams[0]({ type: "server.connected", data: {} })
    await tick(10)
    expect(f.api.calls.get).toBe(gets + 2)
  } finally { controller.dispose(); f.dispose() }
})

test("a reconnect during a doomed root lookup retries once after it fails, unless the chat is no longer watched", async () => {
  const sessions = [session("root", 50), session("other", 50)]
  const f = fixture({ sessions })
  const wins = windows()
  wins.open(1, false)
  const pushed = []
  const controller = f.control(wins, (window) => pushed.push(window))
  const get = f.api.session.get
  const pending = []
  f.api.session.get = (input) => {
    if (pending.length > 0) return get(input)
    f.api.calls.get++
    return new Promise((_, reject) => pending.push(reject))
  }
  try {
    f.runtime.start()
    const watching = controller.watch(1, [{ sessionID: "root", active: true }])
    for (let i = 0; i < 5; i++) f.api.streams[0]({ type: "server.connected", data: {} })
    await tick(10)
    expect(f.api.calls.get).toBe(1)
    pending[0](new Error("old connection reset"))
    await watching
    await tick(10)
    expect(f.api.calls.get).toBe(2)
    expect(controller.state(1).views.root.rootID).toBe("root")
    expect(pushed.at(-1)).toBe(1)

    pending.length = 0
    const old = controller.watch(1, [{ sessionID: "gone", active: true }])
    f.api.streams[0]({ type: "server.connected", data: {} })
    await tick(10)
    await controller.watch(1, [{ sessionID: "other", active: true }])
    const gets = f.api.calls.get
    pending[0](new Error("old connection reset"))
    await old
    await tick(10)
    expect(f.api.calls.get).toBe(gets)
  } finally { controller.dispose(); f.dispose() }
})

test("actions resolve the root chat and Linear linking stays off unless configured", async () => {
  const sessions = [session("root", 50), session("child", 60, "root")]
  const off = fixture({ sessions, messages: { root: [message(200, 300, [{ type: "text", text: "http://localhost:3000" }])] } })
  const wins = windows()
  const controller = createController({ links: off.links, windows: wins, push: () => undefined })
  try {
    await off.links.tracker.scan("root")
    await controller.dismiss("child", "page", "http://localhost:3000")
    expect(viewOf(off.links, "root").pages).toEqual([])
    expect(viewOf(off.links, "root").hidden).toBe(true)
    await controller.restore("child")
    expect(viewOf(off.links, "root").pages).toHaveLength(1)
    await expect(controller.link("child", "WEB-1")).rejects.toThrow("Linear is off")
    await expect(controller.dismiss("missing", "page", "x")).rejects.toThrow()
  } finally { controller.dispose(); off.dispose() }

  const on = fixture({ sessions, options: { linear: { workspace: "acme", teams: ["WEB"] } } })
  const linked = createController({ links: on.links, windows: wins, push: () => undefined })
  try {
    expect(await linked.link("child", "not a ticket")).toBe(false)
    expect(await linked.link("child", "WEB-1")).toBe(true)
    const view = viewOf(on.links, "root")
    expect(view.linear).toBe(true)
    expect(view.issues.map((issue) => issue.identifier)).toEqual(["WEB-1"])
    await linked.dismiss("child", "issue", view.issues[0].key)
    expect(viewOf(on.links, "root").issues).toEqual([])
  } finally { linked.dispose(); on.dispose() }
})

test("the terminal cache is imported once, validated, and never written", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "prt-import-"))
  try {
    const file = (key) => path.join(dir, `plugin.opencode-links.${key}.json`)
    const chats = { byRoot: { root: { pulls: [{ key: "github.com/acme/web#42", url, host: "github.com", owner: "acme", repo: "web", number: 42, created: 1 }], touched: 5, checkpoints: { root: 3, child: { mark: 4 } } } } }
    writeFileSync(file("chats"), JSON.stringify(chats))
    writeFileSync(file("status"), JSON.stringify({ byKey: { x: { title: 1 } } }))
    writeFileSync(file("hidden"), "{not json")
    writeFileSync(file("refresh.github"), JSON.stringify({ claims: { a: { checked: 1, owner: "o", until: 9 } }, failures: {} }))
    const before = ["chats", "status", "hidden", "refresh.github"].map((key) => [readFileSync(file(key), "utf8"), statSync(file(key)).mtimeMs])
    const db = new Map([["linear", JSON.stringify({ byRoot: { r: { items: [], touched: 1 } }, byKey: {}, aliases: {}, organizations: {} })]])
    const store = storage(db)
    expect(importTuiCache(store, ["/nonexistent", dir])).toEqual(["chats"])
    expect(JSON.parse(db.get("chats"))).toEqual(chats)
    expect(db.has("status")).toBe(false)
    expect(db.has("hidden")).toBe(false)
    expect(db.has("refresh.github")).toBe(false)
    db.delete("chats")
    expect(importTuiCache(store, [dir])).toEqual([])
    expect(db.has("chats")).toBe(false)
    const after = ["chats", "status", "hidden", "refresh.github"].map((key) => [readFileSync(file(key), "utf8"), statSync(file(key)).mtimeMs])
    expect(after).toEqual(before)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("the terminal cache lives under the CLI channel's state directory", () => {
  expect(tuiDirectories({ XDG_STATE_HOME: "/state" }, "prod")).toEqual(["/state/opencode/latest/tui"])
  expect(tuiDirectories({ XDG_STATE_HOME: "/state" }, "beta")).toEqual(["/state/opencode/beta/tui", "/state/opencode/latest/tui"])
})

test("the main setup provides the Ipc, imports the terminal cache and tears down", async () => {
  const state = mkdtempSync(path.join(tmpdir(), "prt-main-"))
  const previous = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = state
  try {
    const tui = path.join(state, "opencode", "latest", "tui")
    mkdirSync(tui, { recursive: true })
    writeFileSync(path.join(tui, "plugin.opencode-links.hidden.json"), JSON.stringify({ byRoot: { root: { "http://localhost:3000": true } } }))
    const { main } = await import("../src/desktop/main.ts")
    const store = storage()
    const api = client([session("root", 50)], {})
    const wins = windows()
    wins.open(7, false)
    const provided = []
    const closers = []
    const logs = []
    const cleanup = main({
      options: {},
      get client() { return api },
      storage: store,
      app: { channel: "prod" },
      log: { write: (...args) => logs.push(args) },
      windows: { get: wins.get, on: (event, handler) => { closers.push([event, handler]) } },
      provide(token, impl) {
        provided.push({ token, impl })
        return { changed: () => undefined, emit: () => undefined, dispose: () => undefined }
      },
    })
    expect(logs[0]?.[2]).toEqual({ stores: ["hidden"] })
    expect(provided[0].token).toBe(Links)
    const impl = provided[0].impl
    await impl.watch({ sessions: [{ sessionID: "root", active: false }] }, { window: 7, signal: new AbortController().signal })
    expect(impl.state(7).views.root.hidden).toBe(true)
    await impl.restore({ sessionID: "root" }, { window: 7 })
    expect(impl.state(7).views.root.hidden).toBe(false)
    expect(closers.map(([event]) => event)).toEqual(["close"])
    closers[0][1]({ id: 7 })
    expect(impl.state(7).views).toEqual({})
    expect(api.calls.subscribe).toHaveLength(1)
    cleanup()
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = previous
    rmSync(state, { recursive: true, force: true })
  }
})
