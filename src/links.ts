import type { Host } from "./host.ts"
import { createHidden } from "./hidden.ts"
import { createIssues } from "./issues.ts"
import { linearOptions, type Issue } from "./linear.ts"
import type { Pull } from "./pulls.ts"
import type { ResourceProblem } from "./provider.ts"
import { createStats } from "./stats.ts"
import { createTracker } from "./tracker.ts"
import { createViewed } from "./viewed.ts"

export const SHOWN_ISSUES = 5
const NEUTRAL_AFTER = 10 * 60_000

export type Options = Readonly<Record<string, unknown>>

export function createLinks(host: Host, options: Options) {
  const ceiling = options.refresh === undefined ? undefined : Math.max(15, Number(options.refresh) || 60) * 1000
  const hidden = createHidden(host)
  const stats = createStats(host)
  const viewed = createViewed(host)
  const linear = linearOptions(options.linear ?? false)
  const issues = linear === false ? undefined : createIssues(host, ceiling, linear, hidden, undefined, { stats, viewed })
  const tracker = createTracker(host, ceiling, issues?.extension, hidden, { stats, viewed })
  const show = { prs: options.prs !== false, pages: options.pages !== false }

  const pulls = (rootID: string) => (show.prs ? newestFirst(tracker.pulls(rootID)) : [])
  const pages = (rootID: string) => (show.pages ? newestFirst(tracker.pages(rootID)) : [])
  const allIssues = (rootID: string) => issues?.issues(rootID) ?? []
  const shownIssues = (rootID: string, expanded: boolean) => {
    const all = allIssues(rootID)
    return expanded ? all : all.slice(0, SHOWN_ISSUES)
  }

  return {
    host,
    tracker,
    issues,
    pulls,
    pages,
    allIssues,
    shownIssues,
    stats,
    enter(rootID: string) {
      const now = Date.now()
      const ages = [
        ...pulls(rootID).filter((pull) => tracker.status(pull.key)?.state !== "merged").map((pull) => tracker.status(pull.key)?.checked),
        ...allIssues(rootID).map((issue) => issues?.info(issue)?.checked),
      ].map((checked) => checked === undefined ? undefined : now - checked)
      stats.entry(ages)
      void viewed.mark(rootID).catch(() => undefined)
    },
    neutralPull(pull: Pull) {
      const status = tracker.status(pull.key)
      return status?.state !== "merged" && tracker.waiting(pull) && Date.now() - (status?.checked ?? 0) > NEUTRAL_AFTER
    },
    neutralIssue(issue: Issue) {
      return issues !== undefined && issues.waiting(issue) && Date.now() - (issues.info(issue)?.checked ?? 0) > NEUTRAL_AFTER
    },
    rowsKey: (rootID: string) => [
      pulls(rootID).map((pull) => pull.key).join(),
      pages(rootID).map((page) => page.url).join(),
      allIssues(rootID).map((issue) => `${issue.key}/${issue.created}`).join(),
    ].join("\n"),
    pullHint(rootID: string) {
      const problem = tracker.problem()
      if (problem === "rate-limited" || problem === "unavailable") {
        if (pulls(rootID).length === 0) return undefined
        return problem === "rate-limited" ? "GitHub rate limit; retrying later" : "GitHub status unavailable"
      }
      if ((problem !== "missing" && problem !== "signed-out") || pulls(rootID).some((pull) => tracker.status(pull.key)?.title)) return undefined
      return problem === "missing" ? "Install gh to see PR status" : "Run gh auth login to see PR status"
    },
    issueHint: () => linearHint(issues?.problem()),
    dispose() {
      tracker.dispose()
      issues?.dispose()
      stats.dispose()
    },
  }
}

export type Links = ReturnType<typeof createLinks>

export function linearHint(problem: ResourceProblem | undefined) {
  if (problem === "missing") return "Install linear to see issue status"
  if (problem === "signed-out") return "Run linear auth login for status"
  if (problem === "workspace") return "Check Linear workspace settings"
  if (problem === "rate-limited") return "Linear rate limit; retrying later"
  if (problem === "unavailable") return "Linear status unavailable"
  return undefined
}

export function newestFirst<Item extends { readonly created: number }>(items: readonly Item[]) {
  return [...items].sort((a, b) => b.created - a.created)
}
