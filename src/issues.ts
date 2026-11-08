import type { Host } from "./host.ts"
import {
  fetchIssues, issueIn, issuesFromTool, issuesInUser, mergeIssues,
  type Issue, type IssueInfo, type LinearOptions,
} from "./linear.ts"
import { outputText } from "./pulls.ts"
import { createRefresher, type RefreshOptions } from "./provider.ts"
import type { Stats } from "./stats.ts"
import type { Viewed } from "./viewed.ts"
import type { Hidden } from "./hidden.ts"
import type { Extension } from "./extension.ts"

const FORGET = 90 * 24 * 60 * 60_000
const DONE = /^(completed|canceled|duplicate)$/

export function createIssues(
  host: Host, ceiling: number | undefined, options: LinearOptions, hidden: Hidden, load: typeof fetchIssues = fetchIssues,
  extra: { stats?: Stats; viewed?: Viewed } = {},
) {
  const store = host.store("linear")
  const abort = new AbortController()
  const info = (issue: Issue) => store.value.byKey[store.value.aliases[issue.key] ?? issue.key]

  function aliases(value: IssueInfo) {
    return [value.identifier, ...value.previousIdentifiers].flatMap((identifier) => {
      const alias = issueIn(`https://linear.app/${value.workspace}/issue/${identifier}`, 0, options)
      return alias ? [alias.key] : []
    })
  }

  async function save(rootID: string, found: readonly Issue[]) {
    if (abort.signal.aborted || (found.length === 0 && !store.value.byRoot[rootID])) return
    const now = Date.now()
    await store.update((draft) => {
      draft.byRoot[rootID] = { items: mergeIssues(draft.byRoot[rootID]?.items ?? [], found), touched: now }
      for (const [id, entry] of Object.entries(draft.byRoot))
        if (now - entry.touched > FORGET) delete draft.byRoot[id]
    })
  }

  const source = createRefresher<Issue, IssueInfo>(host, {
    id: "linear",
    checked: (issue) => info(issue)?.checked ?? 0,
    changed: (issue) => issue.created,
    phase: (issue) => DONE.test(info(issue)?.state.type ?? "") ? "terminal" : "active",
    partition: (issue) => issue.workspace,
    background: () => Object.keys(store.value.byRoot).map((rootID) => ({ viewed: extra.viewed?.at(rootID) ?? 0, references: issues(rootID) })),
    canonical: (issue) => info(issue)?.key ?? issue.key,
    load: async (items, signal, sent) => {
      const result = await load(items, signal, sent)
      let problem = result.problem
      for (const [key, value] of result.issues) {
        const pinned = store.value.organizations[value.workspace]
        if (pinned && pinned !== value.organizationID) { result.issues.delete(key); problem = "workspace" }
      }
      return { values: result.issues, problem }
    },
    save: async (_items, values, checked) => {
      const changed = new Set<string>()
      await store.update((draft) => {
        for (const [key, value] of values) {
          const pinned = draft.organizations[value.workspace]
          if (pinned && pinned !== value.organizationID) continue
          const old = draft.byKey[value.key]
          if ((old?.checked ?? 0) > checked) continue
          if (!old || old.title !== value.title || old.identifier !== value.identifier || old.state.name !== value.state.name
            || old.state.type !== value.state.type || old.state.color !== value.state.color) changed.add(key)
          draft.organizations[value.workspace] = value.organizationID
          draft.byKey[value.key] = { ...value, checked }
          for (const alias of [key, value.key, ...aliases(value)]) draft.aliases[alias] = value.key
        }
      })
      return changed
    },
  }, { ceiling, stats: extra.stats })

  const extension: Extension<Issue> = {
    version: 6,
    userVersion: 6,
    user: (text, created) => issuesInUser(text, created, options),
    assistant: (message) => message.type !== "assistant" ? [] : message.content.flatMap((part) => {
      if (part.type !== "tool" || part.name !== "shell" || part.state.status !== "completed") return []
      const command = part.state.input.command
      return typeof command !== "string"
        ? [] : issuesFromTool(command, outputText(part.state.content), part.state.metadata?.exit, part.time.created, options)
    }),
    tool: (command, output, exit, created) => issuesFromTool(command, output, exit, created, options),
    save,
    async dirty(rootID, times, references) {
      const keys = (references ?? issues(rootID)).flatMap((item) => [item.key, info(item)?.key ?? item.key])
      await source.invalidate(keys, times)
    },
  }

  function issues(rootID: string) {
    const found: Issue[] = []
    for (const item of store.value.byRoot[rootID]?.items ?? []) {
      const value = info(item)
      const keys = value ? [item.key, value.key, ...aliases(value)] : [item.key]
      if (hidden.contains(rootID, keys)) continue
      found.push(value ? { ...item, key: value.key, identifier: value.identifier, url: value.url } : item)
    }
    return mergeIssues([], found)
  }

  return {
    extension,
    issues,
    info,
    dismiss(rootID: string, issue: Issue) {
      const value = info(issue)
      return hidden.dismissMany(rootID, value ? [issue.key, value.key, ...aliases(value)] : [issue.key])
    },
    problem: source.problem,
    refresh: (items: readonly Issue[], signal: AbortSignal, options?: RefreshOptions) =>
      source.refresh(items, AbortSignal.any([abort.signal, signal]), options),
    due: source.due,
    waiting: source.waiting,
    subscribe: source.subscribe,
    async link(rootID: string, value: string) {
      const item = issueIn(value, Date.now(), options, true)
      if (!item) return false
      await save(rootID, [item])
      const valueInfo = info(item)
      await hidden.reveal(rootID, valueInfo ? [item.key, valueInfo.key, ...aliases(valueInfo)] : [item.key])
      return true
    },
    dispose: () => abort.abort(),
  }
}

export type Issues = ReturnType<typeof createIssues>
