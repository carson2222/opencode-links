import type { Host, Stored } from "./host.ts"

type Bucket = Stored<"stats">["hours"][string]
type Counts = Bucket["github"]
type ProviderID = "github" | "linear"

const KEEP = 7 * 24 * 60 * 60_000
const FLUSH = 60_000
const AGE_BINS = [15_000, 60_000, 5 * 60_000, Number.POSITIVE_INFINITY]
const LATENCY_BINS = [1_000, 2_000, 5_000, Number.POSITIVE_INFINITY]
const BATCH_BINS = [1, 5, 20, 40]

const counts = (): Counts => ({ requests: 0, failed: 0, loads: 0, keys: 0, background: 0, batches: BATCH_BINS.map(() => 0) })
export const bucket = (): Bucket => ({
  github: counts(), linear: counts(), entries: 0,
  ages: [...AGE_BINS.map(() => 0), 0], latency: LATENCY_BINS.map(() => 0),
})
const bin = (bins: readonly number[], value: number) => Math.max(0, bins.findIndex((limit) => value <= limit))
const hour = (now: number) => new Date(now - (now % 3_600_000)).toISOString()
const sum = (into: number[], from: readonly number[]) => from.forEach((value, index) => { into[index] = (into[index] ?? 0) + value })

export function addBucket(target: Bucket, delta: Bucket) {
  for (const id of ["github", "linear"] as const) {
    const into = target[id]
    const from = delta[id]
    into.requests += from.requests
    into.failed += from.failed
    into.loads += from.loads
    into.keys += from.keys
    into.background += from.background
    sum(into.batches, from.batches)
  }
  target.entries += delta.entries
  sum(target.ages, delta.ages)
  sum(target.latency, delta.latency)
}

export function createStats(host: Host) {
  const store = host.store("stats")
  let pending: Record<string, Bucket> = {}
  const current = () => (pending[hour(Date.now())] ??= bucket())

  async function flush() {
    const deltas = pending
    pending = {}
    if (Object.keys(deltas).length === 0) return
    const now = Date.now()
    await store.update((draft) => {
      for (const [key, delta] of Object.entries(deltas)) addBucket(draft.hours[key] ??= bucket(), delta)
      for (const key of Object.keys(draft.hours)) if (now - Date.parse(key) > KEEP) delete draft.hours[key]
    }).catch(() => undefined)
  }

  const timer = setInterval(() => void flush(), FLUSH)
  timer.unref?.()

  return {
    request(id: ProviderID) {
      current()[id].requests++
    },
    load(id: ProviderID, input: { failed: boolean; keys: number; background: number; batches: readonly number[] }) {
      const target = current()[id]
      target.loads++
      if (input.failed) target.failed++
      target.keys += input.keys
      target.background += input.background
      for (const size of input.batches) target.batches[bin(BATCH_BINS, size)]++
    },
    entry(ages: readonly (number | undefined)[]) {
      const target = current()
      target.entries++
      for (const age of ages) target.ages[age === undefined ? AGE_BINS.length : bin(AGE_BINS, age)]++
    },
    latency(ms: number) {
      current().latency[bin(LATENCY_BINS, ms)]++
    },
    flush,
    dispose() {
      clearInterval(timer)
      void flush()
    },
  }
}

export type Stats = ReturnType<typeof createStats>
