// Writes fake but schema-valid TUI cache rows for one root chat, for rendering heavy cases.
// Usage: bun scripts/fixture.ts --root <sessionID> --dir <XDG_STATE_HOME>/opencode/latest/tui [--issues 14] [--prs 9] [--pages 4] [--workspace acme]
import { Schema } from "effect"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { parseArgs } from "node:util"
import { initial, type StoreKey } from "../src/host.ts"
import { schemas } from "../src/schema.ts"

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    dir: { type: "string" },
    issues: { type: "string", default: "14" },
    prs: { type: "string", default: "9" },
    pages: { type: "string", default: "4" },
    workspace: { type: "string", default: "acme" },
  },
})
if (!values.root || !values.dir) {
  console.error("Usage: bun scripts/fixture.ts --root <sessionID> --dir <state>/opencode/latest/tui [--issues N] [--prs N] [--pages N]")
  process.exit(2)
}
const root = values.root
const dir = values.dir
const workspace = values.workspace
const counts = { issues: Number(values.issues), prs: Number(values.prs), pages: Number(values.pages) }

const TITLES = [
  "Keep the bottom navigation bar fixed while scrolling",
  "Show revision history on the document page",
  "Retry failed uploads after a connection gap",
  "Fix catalog flicker when the filter changes",
  "Add CSV export to the activity history",
  "Stop the gallery from resetting zoom on reconnect",
  "Localize the onboarding checklist",
  "Cache folder summaries between page loads",
  "Explain file retention in the document tooltip",
  "Move the image size slider into the upload form",
  "Handle account switching without a reload",
  "Rate limit the activity alert webhook",
  "Remove the legacy invitation banner",
  "Make the settings page keyboard accessible",
]
const LINEAR_STATES = [
  { name: "In Progress", type: "started", color: "#f2c94c" },
  { name: "Todo", type: "unstarted", color: "#e2e2e2" },
  { name: "In Review", type: "started", color: "#0f783c" },
  { name: "Done", type: "completed", color: "#5e6ad2" },
  { name: "Backlog", type: "backlog", color: "#bec2c8" },
  { name: "Canceled", type: "canceled", color: "#95a2b3" },
  { name: "Duplicate", type: "duplicate", color: "#95a2b3" },
]
const PR_STATES = ["open", "merged", "draft", "merged", "closed", "open", "merged"] as const
const PAGE_HOSTS = ["localhost:3000", "web-2356-stable-page-scroll.shop.localhost:1355", "127.0.0.1:5173", "storybook.localhost:6006"]

const now = Date.now()
const title = (index: number) => TITLES[index % TITLES.length] ?? "Untitled"
const uuid = (seed: number) => `00000000-0000-4000-8000-${seed.toString(16).padStart(12, "0")}`
const organizationID = uuid(1)

function load<K extends StoreKey>(key: K) {
  const file = path.join(dir, `plugin.opencode-links.${key}.json`)
  const codec = Schema.toCodecJson(schemas[key])
  const value = existsSync(file) ? Schema.decodeUnknownSync(codec)(JSON.parse(readFileSync(file, "utf8"))) : initial(key)
  return { value, save: () => writeFileSync(file, `${JSON.stringify(Schema.encodeSync(codec)(value), null, 2)}\n`) }
}

mkdirSync(dir, { recursive: true })
const chats = load("chats")
const status = load("status")
const linear = load("linear")

const pulls = Array.from({ length: counts.prs }, (_, index) => {
  const number = 480 + counts.prs - index
  const repo = index % 3 === 2 ? "api" : "web"
  return { key: `github.com/acme/${repo}#${number}`, url: `https://github.com/acme/${repo}/pull/${number}`, host: "github.com", owner: "acme", repo, number, created: now - index * 3_600_000 }
})
for (const [index, pull] of pulls.entries())
  status.value.byKey[pull.key] = { title: title(index + 3), state: PR_STATES[index % PR_STATES.length] ?? "open", checked: now }

const pages = Array.from({ length: counts.pages }, (_, index) => {
  const host = PAGE_HOSTS[index % PAGE_HOSTS.length] ?? "localhost:3000"
  const origin = `http://${host}`
  const url = index === 0 ? origin : `${origin}/documents/DOC-${index}`
  return { url, origin, label: url.replace(/^https?:\/\//, ""), created: now - index * 1_800_000 }
})

chats.value.byRoot[root] = { pulls, pages, touched: now }

const items = Array.from({ length: counts.issues }, (_, index) => {
  const identifier = `WEB-${2356 - index}`
  return {
    key: `linear:${workspace}:${identifier}`,
    id: uuid(100 + index),
    workspace,
    identifier,
    url: `https://linear.app/${workspace}/issue/${identifier}`,
    created: now - index * 600_000,
    requested: index < 2,
  }
})
for (const [index, item] of items.entries()) {
  linear.value.byKey[item.key] = {
    key: item.key,
    id: item.id,
    organizationID,
    workspace,
    identifier: item.identifier,
    previousIdentifiers: [],
    title: title(index),
    url: item.url,
    state: LINEAR_STATES[index % LINEAR_STATES.length] ?? { name: "Todo", type: "unstarted", color: "#e2e2e2" },
    checked: now,
  }
  linear.value.aliases[item.key] = item.key
}
linear.value.byRoot[root] = { items, touched: now }
linear.value.organizations[workspace] = organizationID

chats.save()
status.save()
linear.save()
console.log(`Wrote ${counts.issues} issues, ${counts.prs} PRs, ${counts.pages} pages for ${root} to ${dir}`)
