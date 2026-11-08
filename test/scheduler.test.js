import { afterEach, beforeEach, expect, test } from "bun:test"
import { createLinks } from "../src/links.ts"
import { createRefresher } from "../src/provider.ts"
import { createStats } from "../src/stats.ts"
import { tuiHost } from "../src/tui-host.ts"

let clock
const realNow = Date.now
beforeEach(() => {
  clock = 10_000_000_000
  Date.now = () => clock
})
afterEach(() => { Date.now = realNow })

const signal = () => new AbortController().signal
const MIN = 60_000
const DAY = 24 * 60 * MIN

function host(shared = new Map()) {
  return tuiHost({
    storage: {
      store(key, options) {
        const state = shared.get(key) ?? structuredClone(options.initial)
        shared.set(key, state)
        return [state, async (mutation) => mutation(state)]
      },
    },
    data: { session: { get: () => undefined }, on: () => () => undefined },
    client: {},
  })
}

function fixture({ phases = {}, groups = [], ceiling, values = () => ({}), load, stats } = {}) {
  const shared = new Map()
  const saved = new Map()
  const requests = []
  const provider = {
    id: "github",
    checked: (reference) => saved.get(reference.key)?.checked ?? 0,
    changed: (reference) => reference.created ?? 0,
    phase: (reference) => phases[reference.key] ?? "active",
    partition: (reference) => reference.partition ?? "host",
    background: () => groups,
    async load(references, signal, sent) {
      requests.push(references.map((reference) => reference.key))
      if (load) return load(references, signal, sent)
      return { values: new Map(references.map((reference) => [reference.key, values(reference.key)])) }
    },
    async save(references, loaded, checked) {
      const changed = new Set()
      for (const reference of references) {
        const value = JSON.stringify(loaded.get(reference.key))
        if (saved.get(reference.key)?.value !== value) changed.add(reference.key)
        saved.set(reference.key, { checked, value })
      }
      return changed
    },
  }
  return { refresher: createRefresher(host(shared), provider, { ceiling, stats }), shared, saved, requests }
}

const row = (key, extra = {}) => ({ key, ...extra })

test("a row slows to 120 s after two unchanged reads a minute apart and speeds up again on change", async () => {
  let title = "A"
  const f = fixture({ values: () => ({ title }) })
  const a = row("a")
  await f.refresher.refresh([a], signal())
  expect(f.refresher.due([a])).toBe(clock + MIN)
  clock += MIN
  await f.refresher.refresh([a], signal())
  expect(f.refresher.due([a])).toBe(clock + MIN)
  clock += MIN
  await f.refresher.refresh([a], signal())
  expect(f.refresher.due([a])).toBe(clock + 2 * MIN)
  title = "B"
  clock += 2 * MIN
  await f.refresher.refresh([a], signal())
  expect(f.refresher.due([a])).toBe(clock + MIN)
  expect(f.requests).toHaveLength(4)
})

test("an explicit refresh option caps the foreground interval", async () => {
  const f = fixture({ ceiling: 30_000 })
  const a = row("a")
  for (let index = 0; index < 4; index++) {
    await f.refresher.refresh([a], signal())
    expect(f.refresher.due([a])).toBe(clock + 30_000)
    clock += 30_000
  }
})

test("merged rows are never polled; entry re-reads only a day-old title, closed rows every 10 minutes", async () => {
  const f = fixture({ phases: { m: "merged", c: "terminal" } })
  const m = row("m")
  const c = row("c")
  await f.refresher.refresh([m, c], signal(), { entered: clock })
  expect(f.refresher.due([m])).toBe(Number.POSITIVE_INFINITY)
  expect(f.refresher.due([c])).toBe(clock + 10 * MIN)
  clock += 2 * 60 * MIN
  await f.refresher.refresh([m], signal(), { entered: clock })
  expect(f.requests).toEqual([["m", "c"]])
  clock += DAY
  await f.refresher.refresh([m], signal(), { entered: clock })
  expect(f.requests).toEqual([["m", "c"], ["m"]])
})

test("burst marks end once the row reaches a terminal state", async () => {
  const phases = {}
  const f = fixture({ phases })
  const a = row("a")
  await f.refresher.refresh([a], signal())
  clock += 1_000
  await f.refresher.invalidate(["a"], [clock, clock + 15_000, clock + 30_000])
  phases.a = "merged"
  await f.refresher.refresh([a], signal())
  expect(f.shared.get("refresh.github").dirty.a).toBeUndefined()
  expect(f.refresher.due([a])).toBe(Number.POSITIVE_INFINITY)
})

test("a foreground read fills spare batch room with eligible background rows, dirty first, never parked or merged", async () => {
  const groups = []
  const f = fixture({ groups, phases: { merged: "merged" } })
  const seed = ["recentOld", "recentNew", "weekOld", "parked", "merged", "dirty", "otherHost"].map((key) => row(key, key === "otherHost" ? { partition: "other" } : {}))
  await f.refresher.refresh(seed, signal())
  f.requests.length = 0
  clock += 2 * 60 * MIN
  for (const key of ["recentNew"]) f.saved.set(key, { checked: clock - MIN })
  groups.push(
    { viewed: clock - 60 * MIN, references: [row("recentOld"), row("recentNew"), row("merged"), row("otherHost", { partition: "other" })] },
    { viewed: clock - 3 * DAY, references: [row("weekOld")] },
    { viewed: clock - 30 * DAY, references: [row("parked")] },
    { viewed: clock - 30 * DAY, references: [row("dirty")] },
  )
  await f.refresher.invalidate(["dirty"], [clock])
  await f.refresher.refresh([row("fg", { created: clock })], signal())
  expect(f.requests).toEqual([["fg", "dirty", "recentOld", "weekOld"]])
})

test("background rows never start a request on their own", async () => {
  const groups = [{ viewed: clock, references: [row("bg", { created: clock })] }]
  const f = fixture({ groups })
  const fg = row("fg")
  await f.refresher.refresh([fg], signal())
  expect(f.requests).toEqual([["fg", "bg"]])
  f.requests.length = 0
  await f.refresher.invalidate(["bg"], [clock])
  await f.refresher.refresh([fg], signal())
  expect(f.requests).toEqual([])
})

test("one batch never overflows to carry background rows", async () => {
  const groups = [{ viewed: clock, references: Array.from({ length: 5 }, (_, index) => row(`bg${index}`, { created: clock })) }]
  const f = fixture({ groups })
  const foreground = Array.from({ length: 40 }, (_, index) => row(`fg${index}`))
  await f.refresher.refresh(foreground, signal())
  expect(f.requests[0]).toHaveLength(40)
  expect(f.requests[0].some((key) => key.startsWith("bg"))).toBe(false)
})

test("entry neutralizes only old non-merged statuses until their read lands, and records counters", async () => {
  const shared = new Map([
    ["chats", { byRoot: { root: { pulls: ["1", "2", "3"].map((n) => ({
      key: `github.com/acme/web#${n}`, url: `https://github.com/acme/web/pull/${n}`, host: "github.com", owner: "acme", repo: "web", number: Number(n), created: 1,
    })), touched: clock } } }],
    ["status", { byKey: {
      "github.com/acme/web#1": { title: "Old", state: "open", checked: clock - 30 * MIN },
      "github.com/acme/web#2": { title: "Recent", state: "open", checked: clock - 5 * MIN },
      "github.com/acme/web#3": { title: "Merged", state: "merged", checked: clock - 30 * DAY },
    } }],
  ])
  const links = createLinks(host(shared), {})
  const controller = new AbortController()
  try {
    const [old, recent, merged] = links.pulls("root").sort((a, b) => a.number - b.number)
    links.enter("root")
    const pending = links.tracker.refresh(links.pulls("root"), controller.signal, { entered: clock })
    expect(links.neutralPull(old)).toBe(true)
    expect(links.neutralPull(recent)).toBe(false)
    expect(links.neutralPull(merged)).toBe(false)
    controller.abort()
    await pending
    expect(shared.get("viewed").byRoot.root).toBe(clock)
    await links.stats.flush()
    const hour = Object.values(shared.get("stats").hours)[0]
    expect(hour.entries).toBe(1)
    expect(hour.ages).toEqual([0, 0, 1, 1, 0])
  } finally {
    links.dispose()
  }
})

const loaded = (references) => ({ values: new Map(references.map((reference) => [reference.key, {}])) })

test("a terminal result keeps invalidations made after its read started and drops only covered marks", async () => {
  const phases = {}
  let release
  const f = fixture({ phases, load: async (references) => { await new Promise((resolve) => { release = resolve }); return loaded(references) } })
  const a = row("a")
  await f.refresher.invalidate(["a"], [clock, clock + 15_000])
  const pending = f.refresher.refresh([a], signal())
  await Bun.sleep(150)
  const started = clock
  clock += 2_000
  await f.refresher.invalidate(["a"], [clock])
  phases.a = "terminal"
  release()
  await pending
  const state = f.shared.get("refresh.github")
  expect(state.dirty.a).toEqual([started + 2_000])
  expect(state.rechecks?.a).toEqual([started + 15_000])
  expect(f.refresher.due([a])).toBeLessThanOrEqual(clock)
})

test("closed or done rows keep pending rechecks until they run, because they can reopen; merged rows drop them", async () => {
  const phases = {}
  const f = fixture({ phases })
  const a = row("a")
  const b = row("b")
  await f.refresher.refresh([a, b], signal())
  clock += 1_000
  await f.refresher.invalidate(["a", "b"], [clock + 1_000, clock + 3_500, clock + 15_500])
  phases.a = "terminal"
  phases.b = "merged"
  clock += 1_000
  await f.refresher.refresh([a, b], signal())
  expect(f.requests).toEqual([["a", "b"], ["a", "b"]])
  const state = f.shared.get("refresh.github")
  expect(state.rechecks?.a).toEqual([clock + 2_500, clock + 14_500])
  expect(state.rechecks?.b).toBeUndefined()
  expect(f.refresher.due([a])).toBe(clock + 2_500)
  expect(f.refresher.due([b])).toBe(Number.POSITIVE_INFINITY)
  clock += 2_500
  await f.refresher.refresh([a], signal())
  clock += 12_000
  await f.refresher.refresh([a], signal())
  expect(f.requests).toHaveLength(4)
  expect(f.shared.get("refresh.github").rechecks?.a).toBeUndefined()
  expect(f.refresher.due([a])).toBe(clock + 10 * MIN)
})

test("entry that reuses a young snapshot confirms it once at the snapshot's 15 s age", async () => {
  const f = fixture()
  const a = row("a")
  await f.refresher.refresh([a], signal())
  const read = clock
  clock += 5_000
  const entered = clock
  await f.refresher.refresh([a], signal(), { entered })
  expect(f.requests).toHaveLength(1)
  expect(f.refresher.due([a], entered)).toBe(read + 15_000)
  clock = read + 15_000
  await f.refresher.refresh([a], signal(), { entered })
  expect(f.requests).toHaveLength(2)
  expect(f.refresher.due([a], entered)).toBe(clock + MIN)
})

test("a row that fails alone backs off by itself and never embargoes healthy rows", async () => {
  const f = fixture({ load: async (references) => {
    const ok = references.filter((reference) => reference.key !== "bad")
    return { ...loaded(ok), problem: "unavailable", failed: new Set(references.filter((reference) => reference.key === "bad").map((reference) => reference.key)) }
  } })
  const good = row("good")
  const bad = row("bad")
  await f.refresher.refresh([good, bad], signal())
  clock += 70_000
  await f.refresher.refresh([bad], signal())
  expect(f.requests.at(-1)).toEqual(["bad"])
  expect(f.refresher.problem()).toBe("unavailable")
  const fresh = row("fresh", { created: clock })
  await f.refresher.refresh([good, bad, fresh], signal())
  expect(f.requests.at(-1)).toEqual(["good", "fresh"])
})

test("vendor requests count when sent, even if the read is then aborted", async () => {
  const shared = new Map()
  const stats = createStats(host(shared))
  const controller = new AbortController()
  const f = fixture({ stats, load: async (references, _signal, sent) => {
    sent()
    controller.abort()
    return loaded(references)
  } })
  try {
    await f.refresher.refresh([row("a")], controller.signal)
    await stats.flush()
    expect(Object.values(shared.get("stats").hours)[0].github.requests).toBe(1)
  } finally { stats.dispose() }
})
