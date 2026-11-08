import { randomUUID } from "node:crypto"
import type { Host, Stored } from "./host.ts"
import type { Problem } from "./schema.ts"
import type { Stats } from "./stats.ts"

export type ResourceProblem = typeof Problem.Type
export type Phase = "active" | "terminal" | "merged"

export type Loaded<Metadata> = {
  values: Map<string, Metadata>
  problem?: ResourceProblem
  failed?: ReadonlySet<string>
  reset?: number
}

export type Provider<Reference extends { key: string }, Metadata> = {
  id: "github" | "linear"
  checked: (reference: Reference) => number
  changed: (reference: Reference) => number
  phase: (reference: Reference) => Phase
  partition: (reference: Reference) => string
  load: (references: readonly Reference[], signal: AbortSignal, sent: () => void) => Promise<Loaded<Metadata>>
  save: (references: readonly Reference[], values: Map<string, Metadata>, checked: number) => Promise<ReadonlySet<string>>
  background?: () => readonly { viewed: number; references: readonly Reference[] }[]
  canonical?: (reference: Reference) => string
}

export type RefreshOptions = { scope?: string; entered?: number }

const ENTRY_AGE = 15_000
const COALESCE = 100
const CHANGED = 60_000
const QUIET = 120_000
const TERMINAL = 10 * 60_000
const TITLE = 24 * 60 * 60_000
const BATCH = 40
const LEASE = 90_000
const FORGET = 90 * 24 * 60 * 60_000
const MARKS = 24 * 60 * 60_000
const HOUR = 60 * 60_000
const DAY = 24 * HOUR
const NEAR = 1_000
const TRANSIENT = [5_000, 15_000, 30_000, 60_000]
const GLOBAL: ReadonlySet<ResourceProblem> = new Set(["missing", "signed-out", "rate-limited"])

type State = Stored<"refresh.github">
type Marks = NonNullable<State["dirty"]>
type Demand<Reference> = { references: readonly Reference[]; signal: AbortSignal; entered?: number }

export function backoff(problem: ResourceProblem, attempts: number, now: number, reset?: number) {
  if (problem === "rate-limited")
    return reset !== undefined && reset > now ? Math.min(reset, now + HOUR) : now + Math.min(15 * 60_000, 60_000 * 2 ** Math.min(attempts - 1, 4))
  if (problem !== "unavailable") return now + 60_000
  return now + Math.round((TRANSIENT[Math.min(attempts, TRANSIENT.length) - 1] ?? 60_000) * (0.8 + Math.random() * 0.4))
}

function add(marks: Marks, key: string, times: readonly number[]) {
  if (times.length === 0) return
  const list = [...(marks[key] ?? [])]
  for (const time of times) {
    const near = list.findIndex((mark) => Math.abs(mark - time) < NEAR)
    if (near < 0) list.push(time)
    else list[near] = Math.max(list[near] ?? time, time)
  }
  marks[key] = list.sort((a, b) => a - b).slice(-8)
}

function keep(marks: Marks, test: (mark: number) => boolean, only?: string) {
  for (const key of only === undefined ? Object.keys(marks) : [only]) {
    const kept = marks[key]?.filter(test) ?? []
    if (kept.length > 0) marks[key] = kept
    else delete marks[key]
  }
}

function migrate(draft: State, from: string, to: string) {
  if (from === to) return
  const claim = draft.claims[from]
  if (claim) {
    const { owner: _owner, until: _until, ...rest } = claim
    const target = draft.claims[to]
    draft.claims[to] = target ? { ...target, checked: Math.max(target.checked, rest.checked) } : rest
    delete draft.claims[from]
  }
  for (const marks of [draft.dirty, draft.rechecks]) {
    const moved = marks?.[from]
    if (!marks || !moved) continue
    delete marks[from]
    add(marks, to, moved)
  }
}

export function createRefresher<Reference extends { key: string }, Metadata>(
  host: Host,
  provider: Provider<Reference, Metadata>,
  options: { ceiling?: number; stats?: Stats } = {},
) {
  const store = host.store(`refresh.${provider.id}`)
  const waiting = host.memory<Record<string, number>>({})
  const listeners = new Set<() => void>()
  const demands = new Map<string, Demand<Reference>>()
  let busy = false
  let requested = false
  let flushing: Promise<void> | undefined

  const poke = () => listeners.forEach((listener) => listener())

  function lastRead(state: State, reference: Reference) {
    return Math.max(state.claims[reference.key]?.checked ?? 0, provider.checked(reference))
  }

  function interval(state: State, reference: Reference) {
    const phase = provider.phase(reference)
    if (phase === "merged") return Number.POSITIVE_INFINITY
    if (phase === "terminal") return TERMINAL
    const steady = (state.claims[reference.key]?.unchanged ?? 0) >= 2 ? QUIET : CHANGED
    return Math.min(steady, options.ceiling ?? steady)
  }

  const stale = (reference: Reference, checked: number, entered: number) =>
    checked < entered - (provider.phase(reference) === "merged" ? TITLE : ENTRY_AGE)

  const marks = (state: State, key: string) => [...(state.dirty?.[key] ?? []), ...(state.rechecks?.[key] ?? [])]

  function dirty(state: State, reference: Reference, checked: number, now: number) {
    return marks(state, reference.key).some((mark) => mark <= now && mark > checked)
  }

  function at(state: State, reference: Reference, now: number, entered?: number) {
    const claim = state.claims[reference.key]
    if ((claim?.until ?? 0) > now) return claim?.until ?? now
    const checked = lastRead(state, reference)
    let next = checked < provider.changed(reference) || dirty(state, reference, checked, now)
      ? now : checked + interval(state, reference)
    if (entered !== undefined && stale(reference, checked, entered)) next = Math.min(next, entered)
    else if (entered !== undefined && checked < entered && provider.phase(reference) !== "merged") next = Math.min(next, checked + ENTRY_AGE)
    for (const mark of marks(state, reference.key)) if (mark > now && mark > checked) next = Math.min(next, mark)
    return Math.max(next, claim?.retry ?? 0, state.failures[provider.id]?.until ?? 0)
  }

  function eligible(state: State, reference: Reference, now: number, recent: boolean, week: boolean) {
    const claim = state.claims[reference.key]
    if ((claim?.until ?? 0) > now || (claim?.retry ?? 0) > now) return undefined
    const phase = provider.phase(reference)
    if (phase === "merged") return undefined
    const checked = lastRead(state, reference)
    if (dirty(state, reference, checked, now) || checked < provider.changed(reference)) return 0
    const age = now - checked
    if (phase === "active" && recent && age > 5 * 60_000) return 1
    if (week && age > HOUR) return 2
    return undefined
  }

  function fill(state: State, claimed: readonly Reference[], now: number) {
    if (!provider.background || claimed.length === 0) return []
    const room = new Map<string, number>()
    for (const reference of claimed) room.set(provider.partition(reference), (room.get(provider.partition(reference)) ?? 0) + 1)
    for (const [partition, count] of room) room.set(partition, Math.ceil(count / BATCH) * BATCH - count)
    const taken = new Set(claimed.map((reference) => reference.key))
    const candidates: { reference: Reference; tier: number; checked: number }[] = []
    for (const group of provider.background()) {
      const recent = now - group.viewed < DAY
        || group.references.some((reference) => dirty(state, reference, lastRead(state, reference), now))
      const week = now - group.viewed < 7 * DAY
      for (const reference of group.references) {
        if (taken.has(reference.key) || !room.get(provider.partition(reference))) continue
        const tier = eligible(state, reference, now, recent, week)
        if (tier === undefined) continue
        taken.add(reference.key)
        candidates.push({ reference, tier, checked: lastRead(state, reference) })
      }
    }
    const picked: Reference[] = []
    for (const candidate of candidates.sort((a, b) => a.tier - b.tier || a.checked - b.checked)) {
      const partition = provider.partition(candidate.reference)
      const left = room.get(partition) ?? 0
      if (left <= 0) continue
      room.set(partition, left - 1)
      picked.push(candidate.reference)
    }
    return picked
  }

  function refresh(references: readonly Reference[], signal: AbortSignal, refreshOptions: RefreshOptions = {}) {
    if (signal.aborted) return Promise.resolve()
    const { scope = "", entered } = refreshOptions
    demands.set(scope, { references: [...references], signal, entered })
    if (entered !== undefined) {
      const state = store.value
      const late = references.filter((reference) =>
        provider.phase(reference) !== "merged" && waiting.value[reference.key] !== entered && stale(reference, lastRead(state, reference), entered))
      if (late.length > 0) waiting.update((draft) => { for (const reference of late) draft[reference.key] = entered })
    }
    if (busy) {
      requested = true
      return Promise.resolve()
    }
    return kick()
  }

  function kick() {
    flushing ??= new Promise((resolve) => setTimeout(resolve, COALESCE)).then(flush)
    return flushing
  }

  function settle(keys: Iterable<string>) {
    const done = [...keys].filter((key) => waiting.value[key] !== undefined)
    if (done.length > 0) waiting.update((draft) => { for (const key of done) delete draft[key] })
  }

  async function flush() {
    flushing = undefined
    const live = [...demands.values()].filter((demand) => !demand.signal.aborted)
    for (const [scope, demand] of demands) if (demand.signal.aborted) demands.delete(scope)
    const wanted = new Map<string, { reference: Reference; entered?: number }>()
    for (const demand of live)
      for (const reference of demand.references) {
        const previous = wanted.get(reference.key)
        const entered = Math.max(previous?.entered ?? -Infinity, demand.entered ?? -Infinity)
        wanted.set(reference.key, { reference, ...(Number.isFinite(entered) ? { entered } : {}) })
      }
    const now = Date.now()
    const due = [...wanted.values()].filter((item) => at(store.value, item.reference, now, item.entered) <= now)
    const blocked = [...wanted.values()].filter((item) =>
      !due.includes(item) && (store.value.claims[item.reference.key]?.until ?? 0) <= now)
    settle(blocked.map((item) => item.reference.key))
    if (due.length === 0) return
    const controller = new AbortController()
    const signals = live.map((demand) => demand.signal)
    const stop = () => { if (signals.every((signal) => signal.aborted)) controller.abort() }
    for (const signal of signals) signal.addEventListener("abort", stop, { once: true })
    const signal = controller.signal
    const owner = randomUUID()
    const claimed: Reference[] = []
    let background = 0
    const entries = new Map(due.flatMap((item) => item.entered === undefined ? [] : [[item.reference.key, item.entered] as const]))
    busy = true
    try {
      await store.update((draft) => {
        if (signal.aborted) return
        for (const { reference, entered } of due) if (at(draft, reference, now, entered) <= now) claimed.push(reference)
        const extra = fill(draft, claimed, now)
        claimed.push(...extra)
        background = extra.length
        for (const reference of claimed)
          draft.claims[reference.key] = { ...draft.claims[reference.key], checked: lastRead(draft, reference), owner, until: now + LEASE }
        for (const [key, claim] of Object.entries(draft.claims))
          if (now - claim.checked > FORGET && (claim.until ?? 0) <= now) delete draft.claims[key]
        for (const list of [draft.dirty, draft.rechecks]) if (list) keep(list, (mark) => now - mark < MARKS)
      })
      if (claimed.length === 0 || signal.aborted) return
      const result = await provider.load(claimed, signal, () => options.stats?.request(provider.id))
      if (signal.aborted) return
      const failed = result.failed
        ?? new Set(result.problem ? claimed.filter((reference) => !result.values.has(reference.key)).map((reference) => reference.key) : [])
      const successful = claimed.filter((reference) => !failed.has(reference.key))
      const problem = failed.size > 0 ? result.problem ?? "unavailable" : result.problem
      const global = problem !== undefined && GLOBAL.has(problem)
      const changed = successful.length > 0 ? await provider.save(successful, result.values, now) : new Set<string>()
      const sizes = [...Map.groupBy(claimed, (reference) => provider.partition(reference)).values()]
        .flatMap((group) => Array.from({ length: Math.ceil(group.length / BATCH) }, (_, index) => Math.min(BATCH, group.length - index * BATCH)))
      options.stats?.load(provider.id, { failed: problem !== undefined, keys: claimed.length, background, batches: sizes })
      const finished = Date.now()
      for (const entered of new Set(successful.flatMap((reference) => {
        const value = entries.get(reference.key)
        return value === undefined || waiting.value[reference.key] !== value ? [] : [value]
      }))) options.stats?.latency(finished - entered)
      await store.update((draft) => {
        for (const reference of claimed) {
          const claim = draft.claims[reference.key]
          if (claim?.owner !== owner) continue
          if (!failed.has(reference.key)) {
            const unchanged = changed.has(reference.key) ? 0
              : now - claim.checked >= CHANGED ? Math.min(2, (claim.unchanged ?? 0) + 1) : claim.unchanged ?? 0
            draft.claims[reference.key] = { checked: now, ...(unchanged > 0 ? { unchanged } : {}) }
            const ended = provider.phase(reference) === "merged"
            if (draft.dirty) keep(draft.dirty, (mark) => mark > now, reference.key)
            if (draft.rechecks) keep(draft.rechecks, (mark) => !ended && mark > now, reference.key)
            migrate(draft, reference.key, provider.canonical?.(reference) ?? reference.key)
            continue
          }
          const attempts = (claim.attempts ?? 0) + 1
          draft.claims[reference.key] = {
            checked: claim.checked,
            ...(claim.unchanged ? { unchanged: claim.unchanged } : {}),
            ...(global || !problem ? {} : { attempts, retry: backoff(problem, attempts, now, result.reset) }),
          }
        }
        if (!global) {
          if (problem !== undefined && successful.length === 0)
            draft.failures[provider.id] = { problem, attempts: 0, until: now }
          else delete draft.failures[provider.id]
          return
        }
        const attempts = (draft.failures[provider.id]?.attempts ?? 0) + 1
        draft.failures[provider.id] = { problem, attempts, until: backoff(problem, attempts, now, result.reset) }
      })
    } catch {
      if (!signal.aborted)
        await store.update((draft) => {
          const attempts = (draft.failures[provider.id]?.attempts ?? 0) + 1
          draft.failures[provider.id] = { problem: "unavailable", attempts, until: backoff("unavailable", attempts, Date.now()) }
        })
    } finally {
      for (const signal of signals) signal.removeEventListener("abort", stop)
      try {
        if (claimed.length > 0)
          await store.update((draft) => {
            for (const reference of claimed) {
              const claim = draft.claims[reference.key]
              if (claim?.owner !== owner) continue
              const { owner: _owner, until: _until, ...rest } = claim
              draft.claims[reference.key] = rest
            }
          })
      } finally {
        busy = false
        if (!signal.aborted) settle(claimed.map((reference) => reference.key))
        if (claimed.length > 0) poke()
        if (requested) {
          requested = false
          void kick()
        }
      }
    }
  }

  return {
    refresh,
    due(references: readonly Reference[], entered?: number) {
      const now = Date.now()
      return Math.min(Number.POSITIVE_INFINITY, ...references.map((reference) => at(store.value, reference, now, entered)))
    },
    waiting(reference: Reference) {
      const entered = waiting.value[reference.key]
      return entered !== undefined && stale(reference, lastRead(store.value, reference), entered)
    },
    async invalidate(keys: readonly string[], times: readonly number[]) {
      if (keys.length === 0 || times.length === 0) return
      const now = Date.now()
      await store.update((draft) => {
        for (const key of new Set(keys)) {
          add(draft.dirty ??= {}, key, times.filter((time) => time <= now))
          add(draft.rechecks ??= {}, key, times.filter((time) => time > now))
        }
      })
      poke()
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    problem: () => store.value.failures[provider.id]?.problem,
  }
}
