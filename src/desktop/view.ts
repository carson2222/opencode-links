import type { Links } from "../links.ts"
import { cleanTitle } from "../pulls.ts"
import type { View } from "./contract.ts"

export function viewOf(links: Links, rootID: string): View {
  const { tracker, issues } = links
  return {
    rootID,
    linear: issues !== undefined,
    issues: links.allIssues(rootID).map((issue) => {
      const info = issues?.info(issue)
      return {
        key: issue.key,
        identifier: issue.identifier,
        title: cleanTitle(info?.title ?? ""),
        url: issue.url,
        requested: issue.requested,
        ...(info ? { state: { type: info.state.type, color: info.state.color } } : {}),
        ...(links.neutralIssue(issue) ? { stale: true } : {}),
      }
    }),
    pulls: links.pulls(rootID).map((pull) => {
      const status = tracker.status(pull.key)
      return {
        key: pull.key,
        number: pull.number,
        repo: pull.repo,
        title: cleanTitle(status?.title ?? ""),
        url: pull.url,
        state: status?.state ?? "unknown",
        ...(links.neutralPull(pull) ? { stale: true } : {}),
      }
    }),
    pages: links.pages(rootID).map((page) => ({
      key: page.url,
      url: page.url,
      label: page.label,
      down: tracker.liveness(page.origin) === "down",
    })),
    issueHint: links.issueHint(),
    pullHint: links.pullHint(rootID),
    hidden: tracker.hasHidden(rootID),
  }
}
