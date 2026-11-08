import { expect, test } from "bun:test"
import { createRefresher } from "../src/provider.ts"
import { tuiHost } from "../src/tui-host.ts"

function deferred() {
  let resolve
  const promise = new Promise((finish) => { resolve = finish })
  return { promise, resolve }
}

async function withClock(start, run) {
  const original = Date.now
  let now = start
  Date.now = () => now
  try {
    await run((amount) => { now += amount })
  } finally {
    Date.now = original
  }
}

function fixture({ id = "github", shared = new Map(), saved = new Map(), load } = {}) {
  let loads = 0
  const mergeSave = async (references, values, checked) => {
    const changed = new Set()
    for (const reference of references) {
      const previous = saved.get(reference.key)
      if ((previous?.checked ?? 0) >= checked) continue
      if (previous?.title !== values.get(reference.key)?.title) changed.add(reference.key)
      saved.set(reference.key, { checked, title: values.get(reference.key)?.title })
    }
    return changed
  }
  const provider = {
    id,
    checked: (reference) => saved.get(reference.key)?.checked ?? 0,
    changed: (reference) => reference.created,
    phase: () => "active",
    partition: () => "host",
    async load(references, signal) {
      loads++
      if (load) return load(references, signal, loads)
      return { values: new Map() }
    },
    save: mergeSave,
  }
  const context = {
    storage: {
      store(key, options) {
        const state = shared.get(key) ?? structuredClone(options.initial)
        shared.set(key, state)
        return [state, async (mutation) => mutation(state)]
      },
    },
  }
  return {
    refresher: createRefresher(tuiHost(context), provider, { ceiling: 60_000 }),
    provider,
    mergeSave,
    saved,
    shared,
    get loads() { return loads },
  }
}

const reference = { key: "foo", created: 0 }
const value = { values: new Map([["foo", { title: "A title" }]]) }

test("fixed credentials recover within one minute even after repeated auth failures", async () => {
  await withClock(100_000, async (advance) => {
    let signedIn = false
    const f = fixture({ load: async () => signedIn ? value : { values: new Map(), problem: "signed-out" } })
    const signal = new AbortController().signal
    await f.refresher.refresh([reference], signal)
    advance(60_000)
    await f.refresher.refresh([reference], signal)
    expect(f.shared.get("refresh.github").failures.github.until).toBe(220_000)
    signedIn = true
    advance(60_000)
    await f.refresher.refresh([reference], signal)
    expect(f.refresher.problem()).toBeUndefined()
    expect(f.saved.get("foo").title).toBe("A title")
  })
})

test("partial failures cannot mark an unresolved reference fresh", async () => {
  await withClock(100_000, async () => {
    const saved = new Map([["bad", { checked: 1, title: "Old title" }]])
    const f = fixture({ saved, load: async () => ({ ...value, problem: "signed-out" }) })
    await f.refresher.refresh([reference, { key: "bad", created: 0 }], new AbortController().signal)
    expect(saved.get("foo")).toEqual({ checked: 100_000, title: "A title" })
    expect(saved.get("bad")).toEqual({ checked: 1, title: "Old title" })
  })
})

test("a warm refresh reuses the first load until its TTL expires", async () => {
  await withClock(100_000, async () => {
    const f = fixture({ load: async () => value })
    await f.refresher.refresh([reference], new AbortController().signal)
    await f.refresher.refresh([reference], new AbortController().signal)
    expect(f.loads).toBe(1)
    expect(f.saved.get("foo")).toEqual({ checked: 100_000, title: "A title" })
  })
})

test("two windows sharing a provider claim an overlapping load once", async () => {
  await withClock(100_000, async () => {
    const entered = deferred()
    const release = deferred()
    let loads = 0
    const load = async () => {
      loads++
      entered.resolve()
      return release.promise
    }
    const shared = new Map()
    const saved = new Map()
    const a = fixture({ shared, saved, load })
    const b = fixture({ shared, saved, load })
    let first
    try {
      first = a.refresher.refresh([reference], new AbortController().signal)
      await entered.promise
      await b.refresher.refresh([reference], new AbortController().signal)
      expect(loads).toBe(1)
      release.resolve(value)
      await first
    } finally {
      release.resolve(value)
    }
  })
})

test("an aborted load does not save or advance checked and releases its claim", async () => {
  await withClock(100_000, async () => {
    const entered = deferred()
    const release = deferred()
    const f = fixture({ load: async (_references, _signal, count) => {
      if (count === 1) {
        entered.resolve()
        return release.promise
      }
      return value
    } })
    const controller = new AbortController()
    let first
    try {
      first = f.refresher.refresh([reference], controller.signal)
      await entered.promise
      controller.abort()
      release.resolve(value)
      await first
      expect(f.saved.has("foo")).toBe(false)
      expect(f.shared.get("refresh.github").claims.foo).toEqual({ checked: 0 })
      await f.refresher.refresh([reference], new AbortController().signal)
      expect(f.loads).toBe(2)
      expect(f.saved.get("foo")).toEqual({ checked: 100_000, title: "A title" })
    } finally {
      controller.abort()
      release.resolve(value)
      if (first) await first
    }
  })
})

test("empty missing, signed-out, and rate-limited results back off across windows", async () => {
  await withClock(100_000, async () => {
    for (const problem of ["missing", "signed-out", "rate-limited"]) {
      const shared = new Map()
      let loads = 0
      const load = async () => {
        loads++
        return { values: new Map(), problem }
      }
      const a = fixture({ shared, load })
      const b = fixture({ shared, load })
      await a.refresher.refresh([reference], new AbortController().signal)
      expect(a.refresher.problem()).toBe(problem)
      await b.refresher.refresh([reference], new AbortController().signal)
      expect(loads).toBe(1)
    }
  })
})

test("a missing ID is negative-cached until the TTL expires", async () => {
  await withClock(100_000, async (advance) => {
    const refs = [{ key: "found", created: 0 }, { key: "missing", created: 0 }]
    const f = fixture({ load: async () => ({ values: new Map([["found", { title: "Found" }]]) }) })
    await f.refresher.refresh(refs, new AbortController().signal)
    expect(f.saved.get("found")).toEqual({ checked: 100_000, title: "Found" })
    expect(f.saved.get("missing")).toEqual({ checked: 100_000, title: undefined })
    advance(59_999)
    await f.refresher.refresh(refs, new AbortController().signal)
    expect(f.loads).toBe(1)
    advance(1)
    await f.refresher.refresh(refs, new AbortController().signal)
    expect(f.loads).toBe(2)
  })
})

test("a changed reference is reloaded within the TTL", async () => {
  await withClock(100_000, async (advance) => {
    const ref = { key: "foo", created: 0 }
    const f = fixture({ load: async () => value })
    await f.refresher.refresh([ref], new AbortController().signal)
    advance(1_000)
    ref.created = 100_001
    await f.refresher.refresh([ref], new AbortController().signal)
    expect(f.loads).toBe(2)
  })
})

test("a throwing load reports unavailable and releases its lease", async () => {
  await withClock(100_000, async () => {
    const f = fixture({ load: async () => { throw new Error("source failed") } })
    await f.refresher.refresh([reference], new AbortController().signal)
    expect(f.refresher.problem()).toBe("unavailable")
    expect(f.shared.get("refresh.github").claims.foo).toEqual({ checked: 0 })
  })
})

test("an expired lease owner cannot release the newer window's claim", async () => {
  await withClock(100_000, async (advance) => {
    const entered = [deferred(), deferred()]
    const release = [deferred(), deferred()]
    const shared = new Map()
    const saved = new Map()
    let loads = 0
    const load = async () => {
      loads++
      entered[loads - 1].resolve()
      return release[loads - 1].promise
    }
    const a = fixture({ shared, saved, load })
    const b = fixture({ shared, saved, load })
    let first
    let second
    try {
      first = a.refresher.refresh([reference], new AbortController().signal)
      await entered[0].promise
      advance(90_001)
      second = b.refresher.refresh([reference], new AbortController().signal)
      await entered[1].promise
      const owner = shared.get("refresh.github").claims.foo.owner
      release[0].resolve({ values: new Map([["foo", { title: "Older" }]]) })
      await first
      expect(shared.get("refresh.github").claims.foo.owner).toBe(owner)
      release[1].resolve({ values: new Map([["foo", { title: "Newer" }]]) })
      await second
      expect(saved.get("foo")).toEqual({ checked: 190_001, title: "Newer" })
    } finally {
      release[0].resolve(value)
      release[1].resolve(value)
      if (first) await first
      if (second) await second
    }
  })
})

test("a save failure releases busy state and retries after backoff", async () => {
  await withClock(100_000, async (advance) => {
    const f = fixture({ load: async () => value })
    const mergeSave = f.mergeSave
    let saves = 0
    f.provider.save = async (...args) => {
      saves++
      if (saves === 1) throw new Error("metadata store busy")
      return mergeSave(...args)
    }
    await f.refresher.refresh([reference], new AbortController().signal)
    expect(f.refresher.problem()).toBe("unavailable")
    expect(f.shared.get("refresh.github").claims.foo).toEqual({ checked: 0 })
    await f.refresher.refresh([reference], new AbortController().signal)
    expect(f.loads).toBe(1)
    advance(60_001)
    await f.refresher.refresh([reference], new AbortController().signal)
    expect(f.loads).toBe(2)
    expect(f.refresher.problem()).toBeUndefined()
    expect(f.saved.get("foo")).toEqual({ checked: 160_001, title: "A title" })
  })
})

test("new references discovered during a load refresh as soon as it finishes", async () => {
  await withClock(100_000, async () => {
    const entered = deferred()
    const release = deferred()
    const requests = []
    const other = { key: "bar", created: 0 }
    const f = fixture({ load: async (references, _signal, count) => {
      requests.push(references.map((item) => item.key))
      if (count === 1) { entered.resolve(); return release.promise }
      return { values: new Map([["bar", { title: "New title" }]]) }
    } })
    const signal = new AbortController().signal
    const first = f.refresher.refresh([reference], signal)
    try {
      await entered.promise
      await f.refresher.refresh([reference, other], signal)
      expect(f.loads).toBe(1)
      release.resolve(value)
      await first
      await Bun.sleep(150)
      expect(requests).toEqual([["foo"], ["bar"]])
      expect(f.saved.get("bar")).toEqual({ checked: 100_000, title: "New title" })
      expect(f.shared.get("refresh.github").claims.bar).toEqual({ checked: 100_000 })
    } finally { release.resolve(value); await first }
  })
})

test("a busy refresher coalesces to the latest displayed references", async () => {
  await withClock(100_000, async () => {
    const entered = deferred()
    const release = deferred()
    const requests = []
    const f = fixture({ load: async (references, _signal, count) => {
      requests.push(references.map((item) => item.key))
      if (count === 1) { entered.resolve(); return release.promise }
      return { values: new Map(references.map((item) => [item.key, { title: "Latest" }])) }
    } })
    const signal = new AbortController().signal
    const first = f.refresher.refresh([reference], signal)
    try {
      await entered.promise
      await f.refresher.refresh([{ key: "bar", created: 0 }], signal)
      await f.refresher.refresh([{ key: "baz", created: 0 }], signal)
      release.resolve(value)
      await first
      await Bun.sleep(150)
      expect(requests).toEqual([["foo"], ["baz"]])
      expect(f.saved.has("bar")).toBe(false)
      expect(f.saved.get("baz").title).toBe("Latest")
    } finally { release.resolve(value); await first }
  })
})

test("blur cancels a queued refresh before it starts", async () => {
  await withClock(100_000, async () => {
    const entered = deferred()
    const release = deferred()
    const f = fixture({ load: async () => { entered.resolve(); return release.promise } })
    const signal = new AbortController().signal
    const queued = new AbortController()
    const first = f.refresher.refresh([reference], signal)
    try {
      await entered.promise
      await f.refresher.refresh([{ key: "bar", created: 0 }], queued.signal)
      queued.abort()
      release.resolve(value)
      await first
      await Bun.sleep(150)
      expect(f.loads).toBe(1)
      expect(f.saved.has("bar")).toBe(false)
    } finally { release.resolve(value); await first }
  })
})

test("hiding the last row clears a queued refresh", async () => {
  await withClock(100_000, async () => {
    const entered = deferred()
    const release = deferred()
    const f = fixture({ load: async () => { entered.resolve(); return release.promise } })
    const signal = new AbortController().signal
    const first = f.refresher.refresh([reference], signal)
    try {
      await entered.promise
      await f.refresher.refresh([{ key: "bar", created: 0 }], signal)
      await f.refresher.refresh([], signal)
      release.resolve(value)
      await first
      await Bun.sleep(150)
      expect(f.loads).toBe(1)
      expect(f.saved.has("bar")).toBe(false)
    } finally { release.resolve(value); await first }
  })
})

test("an aborted old load cannot drop a new root's queued refresh", async () => {
  await withClock(100_000, async () => {
    const entered = deferred()
    const release = deferred()
    const old = new AbortController()
    const next = new AbortController()
    const requests = []
    const f = fixture({ load: async (references, _signal, count) => {
      requests.push(references.map((item) => item.key))
      if (count === 1) { entered.resolve(); return release.promise }
      return { values: new Map([["bar", { title: "Current chat" }]]) }
    } })
    const first = f.refresher.refresh([reference], old.signal)
    try {
      await entered.promise
      old.abort()
      await f.refresher.refresh([{ key: "bar", created: 0 }], next.signal)
      release.resolve(value)
      await first
      await Bun.sleep(150)
      expect(requests).toEqual([["foo"], ["bar"]])
      expect(f.saved.has("foo")).toBe(false)
      expect(f.saved.get("bar").title).toBe("Current chat")
    } finally { release.resolve(value); await first }
  })
})

test("queued work does not bypass rate-limit backoff", async () => {
  await withClock(100_000, async () => {
    const entered = deferred()
    const release = deferred()
    const f = fixture({ load: async () => { entered.resolve(); return release.promise } })
    const signal = new AbortController().signal
    const first = f.refresher.refresh([reference], signal)
    try {
      await entered.promise
      await f.refresher.refresh([{ key: "bar", created: 0 }], signal)
      release.resolve({ values: new Map(), problem: "rate-limited" })
      await first
      await Bun.sleep(150)
      expect(f.loads).toBe(1)
      expect(f.refresher.problem()).toBe("rate-limited")
      expect(f.shared.get("refresh.github").failures.github.until).toBe(160_000)
    } finally { release.resolve(value); await first }
  })
})

test("an already aborted caller cannot replace valid queued work", async () => {
  await withClock(100_000, async () => {
    const entered = deferred()
    const release = deferred()
    const f = fixture({ load: async (references, _signal, count) => {
      if (count === 1) { entered.resolve(); return release.promise }
      return { values: new Map(references.map((item) => [item.key, { title: "Current" }])) }
    } })
    const signal = new AbortController().signal
    const stale = new AbortController()
    stale.abort()
    const first = f.refresher.refresh([reference], signal)
    try {
      await entered.promise
      await f.refresher.refresh([{ key: "bar", created: 0 }], signal)
      await f.refresher.refresh([{ key: "baz", created: 0 }], stale.signal)
      release.resolve(value)
      await first
      await Bun.sleep(150)
      expect(f.loads).toBe(2)
      expect(f.saved.get("bar").title).toBe("Current")
      expect(f.saved.has("baz")).toBe(false)
    } finally { release.resolve(value); await first }
  })
})
