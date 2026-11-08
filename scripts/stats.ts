// Prints the plugin's local request and freshness counters (TUI cache domain).
// bun scripts/stats.ts [stats file]
import { Schema } from "effect"
import { readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { schemas } from "../src/schema.ts"
import { addBucket, bucket } from "../src/stats.ts"

const state = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state")
const file = process.argv[2] ?? path.join(state, "opencode", "latest", "tui", "plugin.opencode-links.stats.json")

const { hours } = Schema.decodeUnknownSync(Schema.toCodecJson(schemas.stats))(JSON.parse(readFileSync(file, "utf8")))
const total = bucket()
console.log("hour (UTC)            gh req  lin req  entries  ages ≤15s/≤60s/≤5m/>5m/never  latency ≤1s/≤2s/≤5s/>5s")
for (const [hour, entry] of Object.entries(hours).sort()) {
  console.log(`${hour.slice(0, 16)}  ${String(entry.github.requests).padStart(6)}  ${String(entry.linear.requests).padStart(7)}  ${String(entry.entries).padStart(7)}  ${entry.ages.join("/").padEnd(30)}  ${entry.latency.join("/")}`)
  addBucket(total, entry)
}
const span = Math.max(1, Object.keys(hours).length)
for (const id of ["github", "linear"] as const) {
  const counts = total[id]
  console.log(`${id}: ${counts.requests} requests (${(counts.requests / span).toFixed(1)}/active hour), ${counts.failed} failed loads, ${(counts.keys / Math.max(1, counts.loads)).toFixed(1)} keys/load, ${counts.background} piggybacked keys, batch sizes 1/≤5/≤20/≤40: ${counts.batches.join("/")}`)
}
console.log(`entries: ${total.entries}; status age at entry ${total.ages.join("/")}; entry revalidation latency ${total.latency.join("/")}`)
