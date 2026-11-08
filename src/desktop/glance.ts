import type { View } from "./contract.ts"

type Issue = View["issues"][number]
type Pull = View["pulls"][number]
type Page = View["pages"][number]

export type Chip =
  | { readonly kind: "issue"; readonly key: string; readonly tier: number; readonly order: number; readonly row: Issue }
  | { readonly kind: "pull"; readonly key: string; readonly tier: number; readonly order: number; readonly row: Pull }
  | { readonly kind: "page"; readonly key: string; readonly tier: number; readonly order: number; readonly row: Page }

const SECTION = { issue: 0, pull: 1, page: 2 } as const

const done = (issue: Issue) => /^(completed|canceled|duplicate)$/.test(issue.state?.type ?? "")

function issueTier(issue: Issue) {
  if (issue.requested) return done(issue) ? 3 : 0
  return done(issue) ? 8 : 5
}

function pullTier(pull: Pull) {
  if (pull.state === "merged") return 4
  if (pull.state === "closed") return 7
  return 1
}

export function glance(view: View): Chip[] {
  const chips: Chip[] = [
    ...view.issues.map((row, order) => ({ kind: "issue" as const, key: row.key, tier: issueTier(row), order, row })),
    ...view.pulls.map((row, order) => ({ kind: "pull" as const, key: row.key, tier: pullTier(row), order, row })),
    ...view.pages.map((row, order) => ({ kind: "page" as const, key: row.key, tier: row.down ? 6 : 2, order, row })),
  ]
  return chips.sort((a, b) => a.tier - b.tier || SECTION[a.kind] - SECTION[b.kind] || a.order - b.order)
}

export const inRowOrder = (chips: readonly Chip[]) =>
  [...chips].sort((a, b) => SECTION[a.kind] - SECTION[b.kind] || a.order - b.order)

export function chipBudget(rowWidth: number) {
  if (rowWidth < 560) return 0
  return Math.min(400, Math.round(rowWidth * 0.3))
}

export function fitCount(widths: readonly number[], budget: number, gap: number) {
  let used = 0
  for (const [index, width] of widths.entries()) {
    used += width + (index > 0 ? gap : 0)
    if (used > budget) return index
  }
  return widths.length
}

export function hiddenSummary(hidden: readonly Chip[]) {
  const count = (kind: Chip["kind"]) => hidden.filter((chip) => chip.kind === kind).length
  const parts: string[] = []
  const issues = count("issue")
  const pulls = count("pull")
  const pages = count("page")
  if (issues) parts.push(`${issues} Linear`)
  if (pulls) parts.push(`${pulls} ${pulls === 1 ? "PR" : "PRs"}`)
  if (pages) parts.push(`${pages} local ${pages === 1 ? "page" : "pages"}`)
  return parts.join(", ")
}

export const pageHost = (page: Page) => page.label.split("/")[0] ?? page.label
