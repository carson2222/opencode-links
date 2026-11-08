import { execCli } from "./cli.ts"
import { createdPulls } from "./pulls.ts"
import { andToEnd, commandIndex, controls, echoText, exitUnknown, invocation, literal, literalPrefix, literals, overrides, replays, shellStatements, type Statement } from "./shell.ts"
import type { Issue as IssueSchema, IssueInfo as IssueInfoSchema, Problem } from "./schema.ts"

export type LinearOptions = { workspace?: string; teams?: readonly string[] }
export type Issue = typeof IssueSchema.Type
export type IssueInfo = typeof IssueInfoSchema.Type
export type LinearProblem = typeof Problem.Type

const WORKSPACE = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/i
const TEAM = /^[a-z][a-z0-9]{0,31}$/i
const IDENTIFIER = /^[a-z][a-z0-9]{0,31}-[1-9]\d{0,14}$/i
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i
const CANDIDATE = /https:\/\/linear\.app\/[^\s`'"<>]+|(?<![\w/-])[a-z][a-z0-9]{0,31}-[1-9]\d{0,14}(?![\w/-])/gi
const QUERY = `query SidebarIssues($ids: [ID!]!, $first: Int!, $after: String) {
  organization { id urlKey }
  issues(first: $first, after: $after, includeArchived: true, filter: { id: { in: $ids } }) {
    nodes { id identifier previousIdentifiers title url state { name type color } }
    pageInfo { hasNextPage endCursor }
  }
}`

export function linearOptions(value: unknown): LinearOptions | false {
  if (value === false) return false
  if (value === undefined || value === true) return {}
  if (!record(value)) return false
  const options: LinearOptions = {}
  if (value.workspace !== undefined) {
    if (typeof value.workspace !== "string" || !WORKSPACE.test(value.workspace)) return false
    options.workspace = value.workspace.toLowerCase()
  }
  if (value.teams !== undefined) {
    if (!Array.isArray(value.teams) || !value.teams.every((team) => typeof team === "string" && TEAM.test(team))) return false
    options.teams = [...new Set(value.teams.map((team: string) => team.toUpperCase()))]
  }
  return options
}

export function issueIn(value: string, created: number, options: LinearOptions, requested = false): Issue | undefined {
  const raw = value.trim()
  if (!Number.isFinite(created) || /[\s<>"'`]/.test(raw)) return undefined
  if (IDENTIFIER.test(raw)) {
    const workspace = options.workspace?.toLowerCase()
    const identifier = raw.toUpperCase()
    if (!workspace || !WORKSPACE.test(workspace) || !options.teams?.some((team) => `${team.toUpperCase()}-` === identifier.slice(0, identifier.lastIndexOf("-") + 1))) return undefined
    return issue(workspace, identifier, `https://linear.app/${workspace}/issue/${identifier}`, created, requested)
  }
  try {
    const url = new URL(raw)
    if (url.protocol !== "https:" || url.hostname !== "linear.app" || url.port || url.username || url.password) return undefined
    const parts = url.pathname.split("/")
    const workspace = parts[1]?.toLowerCase()
    const identifier = parts[3]?.toUpperCase()
    if (!workspace || !WORKSPACE.test(workspace) || parts[2] !== "issue" || !identifier || !IDENTIFIER.test(identifier)) return undefined
    if (parts.length > 5 || (parts[4] !== undefined && !/^[\w%-]*$/.test(parts[4]))) return undefined
    const suffix = parts[4] ? `/${parts[4]}` : ""
    return issue(workspace, identifier, `https://linear.app/${workspace}/issue/${identifier}${suffix}${url.search}${url.hash}`, created, requested)
  } catch {
    return undefined
  }
}

function issue(workspace: string, identifier: string, url: string, created: number, requested: boolean): Issue {
  return { key: `linear:${workspace}:${identifier}`, workspace, identifier, url, created, requested }
}

export function issuesInUser(text: string, created: number, options: LinearOptions): Issue[] {
  if (/^\s*(?:You are a subagent spawned by another session\.|Instructions from:|<skill_content\b|<system-reminder\b|#\s*(?:Checkpoint|Compaction|Conversation summary|Summary)\b)/i.test(text)) return []
  const legacy = /^(?:Work on this Linear ticket\.|Work on this Linear issue or more at once\.)\n/.test(text)
  const current = /^Start work on the Linear issue IDs or links and any extra notes below\./.test(text)
    ? /\n[\t ]*\nCarson's prompt:[\t ]*(?:\n|$)/.exec(text) : null
  const template = legacy || current !== null
  if (legacy) {
    const end = [...text.matchAll(/Merging stays mine\.|or extent future issues\.|group stuff in one pr per repo etc\./g)].at(-1)
    const after = end ? end.index + end[0].length : 0
    const boundary = /^[\t ]*\n(?:[\t ]*\n)+/.exec(text.slice(after))
    if (!end || !boundary || !/Read the (?:ticket|issue), its comments and the code it touches\./.test(text.slice(0, after))) return []
    text = text.slice(after + boundary[0].length)
  }
  if (current) text = text.slice(current.index + current[0].length).replace(/^(?:[\t ]*\n)+/, "")
  const bare = text
    .replace(/<(skill_content|system-reminder|checkpoint|conversation-checkpoint|tool_output)\b[^>]*>[\s\S]*?(?:<\/\1>|$)/gi, "")
    .replace(/```[^\n]*\n[\s\S]*?(?:```|$)|~~~[^\n]*\n[\s\S]*?(?:~~~|$)/g, "")
    .replace(/`[^`\n]*`|"[^"\n]*"|'[^'\n]*'|“[^”\n]*”|‘[^’\n]*’/g, "")
  const found: Issue[] = []
  let intent = template
  let pasted = false
  for (const line of bare.split("\n")) {
    if (!line.trim()) {
      intent = false
      continue
    }
    if (/^\s*(?:\$ |linear |Updating issue |Creating issue|✓|Error:|# [a-z][a-z0-9]*-\d+:)/i.test(line)) {
      pasted = true
      intent = false
      continue
    }
    if (/^(?:\s*>|\s{4}|\t|\s*(?:\[|\{))/.test(line)) continue
    const prose = line.replace(CANDIDATE, "")
    if (/\b(?:example|e\.g\.|previous|previously|already|prior|earlier|deferred|later|not (?:working|work)|don't|do not|log|checkpoint|summary|reference|context|mentioned|branch|title)\b/i.test(prose)) {
      intent = false
      continue
    }
    const explicit = /\b(?:work on|implement|fix|execute|handle|take on|start|link|task|targets?|core|same-pass cleanup)\b/i.test(line)
    const { targets, onlyTargets } = requestedIn(line, explicit || intent)
    if (pasted && !explicit) continue
    if (explicit) pasted = false
    if (explicit) intent = true
    const chosen = explicit || onlyTargets ? targets : intent ? leadingIn(line) : addressedIn(line)
    if (!chosen.length && !explicit && !onlyTargets && !intent) continue
    if (!targets.length && !/\b(?:issues?|tickets?|targets?|tasks?)\b/i.test(line)) intent = false
    for (const target of chosen) {
      const foundIssue = issueIn(target, created, options, true)
      if (foundIssue) found.push(foundIssue)
    }
  }
  return mergeIssues([], found)
}

function leadingIn(line: string): string[] {
  return line.split(/(?<=[.?!])\s+/).flatMap((sentence, index) => {
    const { targets, onlyTargets } = requestedIn(sentence, index === 0)
    return index === 0 || onlyTargets ? targets : []
  })
}

function addressedIn(line: string): string[] {
  const matches = [...line.matchAll(CANDIDATE)]
  const match = matches[0]
  if (matches.length !== 1 || !match || !/^\s*$|,\s+$/.test(line.slice(0, match.index))) return []
  const value = trimTarget(match[0])
  return /^(?:,|\s+is\b)/.test(line.slice(match.index + value.length)) ? [value] : []
}

function requestedIn(line: string, allowNotes: boolean): { targets: string[]; onlyTargets: boolean } {
  const separators = (text: string) => text.replace(/[\s,+&.:;()\[\]*-]|\band\b/gi, "") === ""
  const targets: string[] = []
  const proseNotes: string[] = []
  let outside = ""
  let note = ""
  let noted: string[] = []
  let depth = 0
  let balanced = true
  const read = (text: string) => {
    for (const char of text) {
      if (char === ")" && depth === 0) balanced = false
      else if (char === "(" || char === ")") {
        depth += char === "(" ? 1 : -1
        if (depth === 0) {
          if (separators(note)) targets.push(...noted)
          else proseNotes.push(...noted)
          note = ""
          noted = []
        }
      }
      else if (depth) note += char
      else outside += char
    }
  }
  let last = 0
  for (const match of line.matchAll(CANDIDATE)) {
    read(line.slice(last, match.index))
    const value = trimTarget(match[0])
    if (depth) noted.push(value)
    else targets.push(value)
    last = match.index + value.length
  }
  read(line.slice(last))
  return { targets: targets.length || !allowNotes ? targets : proseNotes, onlyTargets: balanced && depth === 0 && separators(outside) }
}

function trimTarget(value: string): string {
  let end = value.length
  while (end > 0) {
    const char = value[end - 1] ?? ""
    const head = value.slice(0, end)
    if (!/[.,;:!?\]]/.test(char) && !(char === ")" && head.split(")").length > head.split("(").length)) break
    end--
  }
  return value.slice(0, end)
}

type Action = { kind: "create" | "update" | "start"; target?: string; workspace?: string; team?: string }
type Producer = { index: number; kind: "create" | "update" | "comment"; target?: string; workspace?: string; team?: string; tail: boolean }

export function issuesFromTool(command: string, output: string, exit: unknown, created: number, options: LinearOptions): Issue[] {
  if (exit !== 0) return []
  const parsed = shellStatements(command)
  if (!parsed || parsed.statements.some(overrides)) return []
  const lines = output.replace(/\x1b\[[\d;]*m/g, "").split("\n").map((line) => line.trim())
  const shown = lines.flatMap((line) => issueIn(line, created, options) ?? [])
  const text = `${command}\n${parsed.texts.join("\n")}`
  return mergeIssues([], [
    ...confirmedByOutput(parsed.statements, lines, text, shown, created, options),
    ...updatedByExit(parsed.statements, shown, created, options),
    ...ownedWork(parsed.statements, lines, text, createdPulls(command, output, exit, created).proven, created, options),
  ])
}

function ownedWork(
  statements: readonly Statement[], lines: readonly string[], text: string, proven: ReadonlySet<number>, created: number, options: LinearOptions,
): Issue[] {
  const replayed = statements.some((statement) => replays(statement, linearHook))
  const decides = !statements.some((statement) => statement.link === "or" || statement.link === "background" || controls(statement))
  const succeeded = (index: number, branch: string) => {
    const statement = statements[index]
    if (!statement || statement.stages.length || exitUnknown(statement)) return false
    if (decides && andToEnd(statements, index)) return true
    const proof = new RegExp(`(?:new branch|Switched to (?:a new )?branch|Reset branch) '${branch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'`)
    return !replayed && lines.some((line) => proof.test(line) && !text.includes(line))
  }
  const names: string[] = []
  let current: { branch: string; index: number } | undefined
  statements.forEach((statement, index) => {
    const git = branchOf(statement)
    if (git?.created && succeeded(index, git.created)) names.push(git.created)
    if (git?.switched) current = { branch: git.switched, index }
    if (git?.moved) current = undefined
    const pull = pullOf(statement)
    if (!pull || exitUnknown(statement) || !proven.has(index)) return
    if (pull.title) names.push(pull.title)
    const head = pull.head ?? (current && statements.slice(current.index, index).every(({ link }) => link === "and") ? current.branch : undefined)
    if (head) names.push(head.slice(head.indexOf(":") + 1))
  })
  return names.flatMap((name) => [
    ...[...name.matchAll(/https:\/\/linear\.app\/[^\s`'"<>]+/g)].flatMap(([url]) => issueIn(trimTarget(url), created, options) ?? []),
    ...[...name.matchAll(/(?<![a-z0-9])[a-z][a-z0-9]{0,31}-[1-9]\d{0,14}(?!\d)/gi)].flatMap(([id]) => issueIn(id.toUpperCase(), created, options) ?? []),
  ])
}

function branchOf(statement: Statement): { created?: string; switched?: string; moved?: boolean } | undefined {
  const call = invocation(statement)
  if (call?.name === "cd" || call?.name === "pushd" || call?.name === "popd") return { moved: true }
  if (call?.name !== "git") return undefined
  const args = [...call.args]
  let elsewhere = false
  while (args[0]?.startsWith("-")) {
    const option = args.shift()
    if (option === "-C" || option === "-c") args.shift()
    elsewhere ||= option === "-C" || (option?.startsWith("--git-dir") ?? false) || (option?.startsWith("--work-tree") ?? false)
  }
  const command = args.shift()
  const value = (...flags: string[]) => optionValue(args, flags)
  const positional = () => args[args.findIndex((arg, index) => !arg?.startsWith("-") && !/^-[bBcC]$|^--(?:create|force-create|orphan)$/.test(args[index - 1] ?? ""))]
  if (command === "checkout" || command === "switch") {
    const created = command === "checkout" ? value("-b", "-B", "--orphan") : value("-c", "-C", "--create", "--force-create", "--orphan")
    const switched = created ?? (args.includes("--") || args.includes("--detach") || args.includes("-d") ? undefined : positional())
    return { created, switched: elsewhere ? undefined : switched }
  }
  if (command === "worktree" && args[0] === "add") return { created: value("-b", "-B") }
  if (command === "branch" && args.every((arg) => arg === undefined || !arg.startsWith("-") || /^(?:-f|--force|-t|--track|--no-track|-q|--quiet)$/.test(arg))) return { created: positional() }
  return undefined
}

function pullOf(statement: Statement): { title?: string; head?: string } | undefined {
  const call = invocation(statement)
  if (call?.name !== "gh" || call.args[0] !== "pr" || call.args[1] !== "create") return undefined
  const args = call.args.slice(2)
  return { title: optionValue(args, ["--title", "-t"]), head: optionValue(args, ["--head", "-H"]) }
}

function optionValue(args: readonly (string | undefined)[], flags: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    const flag = flags.find((name) => arg === name || (name.startsWith("--") && arg?.startsWith(`${name}=`)))
    if (flag) return arg === flag ? args[index + 1] : arg?.slice(flag.length + 1)
  }
  return undefined
}

function updatedByExit(statements: readonly Statement[], shown: readonly Issue[], created: number, options: LinearOptions): Issue[] {
  if (statements.some((statement) => !statement.plain || statement.binding || statement.link === "or" || statement.link === "background" || controls(statement))) return []
  return statements.flatMap((statement, index) => {
    const action = actionOf(statement)
    if (action?.kind !== "update" || statement.stages.length || !andToEnd(statements, index)) return []
    return byExit(action, shown, created, options)
  })
}

function byExit(action: Action, shown: readonly Issue[], created: number, options: LinearOptions): Issue[] {
  if (!action.target) return []
  const found = issueIn(action.target, created, { workspace: action.workspace ?? options.workspace, teams: [action.target.slice(0, action.target.lastIndexOf("-"))] })
  if (!found || shown.some((issue) => issue.identifier === found.identifier && issue.workspace !== found.workspace)) return []
  return [found]
}

function confirmedByOutput(statements: readonly Statement[], lines: readonly string[], text: string, shown: readonly Issue[], created: number, options: LinearOptions): Issue[] {
  const actions = statements.map(actionOf)
  const start = actions.find((action) => action !== undefined)
  if (start?.kind === "start") return started(statements, actions, lines, created, options)
  if (statements.some((statement) => replays(statement, linearHook))) return []
  const producers = statements.flatMap((statement, index): Producer[] => {
    const tail = statement.stages.length === 1 && tailed(statement.stages[0] ?? []) && statement.out === "pipe" && statement.visible
    if (!tail && (statement.stages.length || statement.out !== "out")) return []
    const action = actions[index]
    if (action && action.kind !== "start") return [{ index, ...action, kind: action.kind, tail }]
    const target = commentOf(statement)
    return target ? [{ index, kind: "comment", target, tail }] : []
  })
  const matched = new Map<number, { issue?: Issue; strong: boolean }>()
  let next = 0
  let unexplained = false
  for (let at = 0; at < lines.length; at++) {
    const line = lines[at] ?? ""
    const url = line.startsWith("https://") ? issueIn(line, created, options) : undefined
    if (!url) continue
    if (text.includes(line)) {
      unexplained = true
      continue
    }
    let before = at - 1
    while (before >= 0 && !lines[before]) before--
    const header = before >= 0 && !text.includes(lines[before] ?? "") ? lines[before] ?? "" : ""
    const comment = /#comment-[\w-]*$/.test(line)
    const open = producers.flatMap((producer, position) => matched.has(position) ? [] : [{ producer, position, fit: fits(producer, url, header, comment) }])
    const match = open.find(({ fit }) => fit === "strong") ?? open.find(({ fit, position }) => fit === "weak" && position >= next)
    if (!match) {
      unexplained = true
      continue
    }
    if (match.position < next) unexplained = true
    next = Math.max(next, match.position + 1)
    matched.set(match.position, { issue: match.producer.kind === "comment" ? undefined : url, strong: match.fit === "strong" })
  }
  const counted = [...matched].filter(([, match]) => match.strong || !unexplained)
  const verified = new Set(counted.map(([position]) => producers[position]?.index))
  return [...counted.flatMap(([, match]) => match.issue ?? []), ...markedUpdates(statements, actions, verified, lines, shown, created, options)]
}

function fits(producer: Producer, url: Issue, header: string, comment: boolean): "strong" | "weak" | undefined {
  if (producer.kind === "comment") {
    if (!comment || (producer.target && IDENTIFIER.test(producer.target) && producer.target !== url.identifier)) return undefined
    const added = /^✓ (?:Comment added to|Added (?:comment|reply) to issue) (\S+)$/.exec(header)?.[1]?.toUpperCase()
    const updated = /^✓ (?:Comment updated|Updated comment (\S+))$/.exec(header)
    if (added === url.identifier || (updated && (!updated[1] || !producer.target || updated[1].toLowerCase() === producer.target.toLowerCase()))) return "strong"
    return producer.tail ? "weak" : undefined
  }
  if (comment || (producer.workspace && producer.workspace !== url.workspace)) return undefined
  const headed = /^✓ (Created|Updated) issue ([A-Za-z][A-Za-z0-9]*-[1-9]\d*): .+$/.exec(header)
  const own = headed?.[2]?.toUpperCase() === url.identifier
  if (producer.kind === "update") {
    if (producer.target !== url.identifier) return undefined
    if (headed) return headed[1] === "Updated" && own ? "strong" : undefined
    return producer.tail ? "weak" : undefined
  }
  if (producer.team && !url.identifier.startsWith(`${producer.team}-`)) return undefined
  if (headed) return headed[1] === "Created" && own ? "strong" : undefined
  const creating = /^Creating issue(?: in ([a-z][a-z0-9]*))?(?:\.\.\.)?$/i.exec(header)
  return !creating?.[1] || url.identifier.startsWith(`${creating[1].toUpperCase()}-`) ? "weak" : undefined
}

function markedUpdates(
  statements: readonly Statement[], actions: readonly (Action | undefined)[], verified: ReadonlySet<number | undefined>,
  lines: readonly string[], shown: readonly Issue[], created: number, options: LinearOptions,
): Issue[] {
  if (statements.some(controls)) return []
  const echoes = statements.map(echoText)
  const printed = (index: number) => {
    const echo = echoes[index]
    return echo !== undefined && echoes.filter((other) => other === echo).length === 1 && lines.includes(echo)
  }
  return statements.flatMap((statement, index) => {
    const action = actions[index]
    if (action?.kind !== "update" || !action.target) return []
    const status = statements[index + 1]?.words.some((word) => word.parts.some((part) => "name" in part && part.name === "?"))
    let proven = status === true && statement.link !== "or" && printed(index + 1)
    for (let at = index + 1; !proven && at < statements.length && statements[at - 1]?.link === "and"; at++) {
      const words = echoes[at]?.split(/\s+/) ?? []
      proven = verified.has(at) || ((words.includes(action.target) || (statement.binding !== undefined && words.includes(statement.binding.value))) && printed(at))
    }
    return proven ? byExit(action, shown, created, options) : []
  })
}

function started(statements: readonly Statement[], actions: readonly (Action | undefined)[], lines: readonly string[], created: number, options: LinearOptions): Issue[] {
  const index = actions.findIndex((action) => action !== undefined)
  const start = actions[index]
  if (!start?.target || actions.filter((action) => action !== undefined).length > 1 || statements[index]?.out !== "out" || statements[index]?.stages.length) return []
  if (statements.some((statement, at) => !statement.plain || statement.binding || (at !== index && literal(statement.words[0]) !== "cd"))) return []
  const filled = lines.filter(Boolean)
  if (!/^✓ Issue state updated to '.+'$/.test(filled.at(-1) ?? "") || filled.filter((line) => line.startsWith("✓ Issue state updated to ")).length !== 1) return []
  return byExit(start, [], created, options)
}

function actionOf(statement: Statement): Action | undefined {
  if (statement.compound || exitUnknown(statement)) return undefined
  const words = literals(statement.words)
  return words ? actionIn(words) : undefined
}

function commentOf(statement: Statement): string | undefined {
  const words = literals(statement.words)
  const args = words && linearArgs(words)
  if (statement.compound || exitUnknown(statement) || !args) return undefined
  const rest = withoutWorkspace(args)
  const target = rest[3] ?? ""
  if (!comments(rest)) return undefined
  return IDENTIFIER.test(target) ? target.toUpperCase() : UUID.test(target) ? target.toLowerCase() : undefined
}

function withoutWorkspace(args: readonly string[]): string[] {
  return args.filter((arg, index) => arg !== "--workspace" && args[index - 1] !== "--workspace" && !arg.startsWith("--workspace="))
}

function comments(args: readonly string[]): boolean {
  return args[0] === "issue" && args[1] === "comment" && (args[2] === "add" || args[2] === "update")
}

function linearReplays(args: readonly (string | undefined)[]): boolean {
  if (args.some((arg) => arg === undefined)) return true
  const words = args.filter((arg): arg is string => arg !== undefined)
  if (actionIn(["linear", ...words])) return false
  const rest = withoutWorkspace(words)
  if (comments(rest)) return false
  if (rest[0] === "issue" && rest[1] === "relation" && rest[2] === "add" && !rest.some((arg) => arg === "--help" || arg === "-h")) return false
  if (rest[0] === "issue" && /^(?:list|query|search|mine)$/.test(rest[1] ?? "")) return false
  return !(rest[0] !== undefined && rest[1] === "list")
}

const linearHook = (command: string, args: readonly (string | undefined)[]) => command === "linear" ? linearReplays(args) : undefined

function linearArgs(input: readonly string[]): string[] | undefined {
  const tokens = [...input]
  while (/^[a-z_][\w]*=/i.test(tokens[0] ?? "")) tokens.shift()
  if (tokens[0] === "snip") tokens.shift()
  return /^(?:[\w./-]*\/)?linear$/.test(tokens.shift() ?? "") ? tokens : undefined
}

function actionIn(input: string[]): Action | undefined {
  const tokens = linearArgs(input)
  if (!tokens) return undefined
  if (tokens.some((token) => token === "--help" || token === "-h" || token === "--version")) return undefined
  let workspace: string | undefined
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index] ?? ""
    if (token === "--workspace" || token.startsWith("--workspace=")) {
      const value = token === "--workspace" ? tokens[index + 1] : token.slice(12)
      if (!value || !WORKSPACE.test(value)) return undefined
      if (workspace && workspace !== value.toLowerCase()) return undefined
      workspace = value.toLowerCase()
      tokens.splice(index, token === "--workspace" ? 2 : 1)
      index--
    }
  }
  if (tokens.shift() !== "issue") return undefined
  const kind = tokens.shift()
  if (kind !== "create" && kind !== "update" && kind !== "start") return undefined
  if (kind !== "create") {
    const target = tokens.shift()
    if (!target || !IDENTIFIER.test(target)) return undefined
    return { kind, target: target.toUpperCase(), workspace }
  }
  const teamIndex = tokens.indexOf("--team")
  const team = teamIndex >= 0 ? tokens[teamIndex + 1] : tokens.find((token) => token.startsWith("--team="))?.slice(7)
  if (team !== undefined && !TEAM.test(team)) return undefined
  return { kind, workspace, team: team?.toUpperCase() }
}

function tailed(tokens: readonly (string | undefined)[]): boolean {
  if (tokens[0] !== "tail") return false
  if (tokens.length === 2) return /^-n?[1-9]\d{0,3}$/.test(tokens[1] ?? "")
  return tokens.length === 3 && tokens[1] === "-n" && /^[1-9]\d{0,3}$/.test(tokens[2] ?? "")
}

export function mergeIssues(existing: readonly Issue[], found: readonly Issue[]): Issue[] {
  const merged = new Map<string, Issue>()
  const earliest = new Map<string, number>()
  const persisted = new Set(existing.map((item) => item.key))
  for (const item of [...existing, ...found]) {
    const previous = merged.get(item.key)
    if (!previous) {
      merged.set(item.key, { ...item })
      earliest.set(item.key, item.created)
    }
    else {
      const primary = !persisted.has(item.key) && item.created < (earliest.get(item.key) ?? previous.created) ? item : previous
      const id = previous.id ?? item.id
      earliest.set(item.key, Math.min(item.created, earliest.get(item.key) ?? previous.created))
      merged.set(item.key, { ...primary, ...(id ? { id } : {}), requested: item.requested || previous.requested, created: Math.max(item.created, previous.created) })
    }
  }
  return [...merged.values()].sort((a, b) => Number(b.requested) - Number(a.requested) || b.created - a.created || a.key.localeCompare(b.key))
}

export async function fetchIssues(
  issues: readonly Issue[], signal?: AbortSignal, sent?: () => void,
): Promise<{ issues: Map<string, IssueInfo>; problem?: LinearProblem }> {
  const found = new Map<string, IssueInfo>()
  let problem: LinearProblem | undefined
  for (const [workspace, group] of Map.groupBy(issues, (item) => item.workspace)) {
    if (signal?.aborted) break
    if (!WORKSPACE.test(workspace) || workspace !== workspace.toLowerCase()) {
      problem ??= "workspace"
      continue
    }
    const unique = [...new Map(group.map((item) => [lookupID(item), lookupID(item)])).values()].filter((id) => id !== undefined)
    for (let start = 0; start < unique.length; start += 40) {
      if (signal?.aborted) break
      const ids = unique.slice(start, start + 40)
      const batch = group.filter((item) => ids.includes(lookupID(item) ?? ""))
      const cursors = new Set<string>()
      const loaded = new Map<string, IssueInfo>()
      const ambiguous = new Set<string>()
      let after: string | undefined
      for (let page = 0; page < ids.length; page++) {
        if (signal?.aborted) break
        sent?.()
        const result = await linear(["api", QUERY, "--variables-json", JSON.stringify({ ids, first: ids.length, ...(after ? { after } : {}) }), "--workspace", workspace], signal)
        if (signal?.aborted) return { issues: found, problem }
        problem ??= result.problem
        const parsed = parseBatch(batch, workspace, result.stdout)
        problem ??= parsed.problem
        parsed.issues.forEach((info, key) => {
          const previous = loaded.get(key)
          if (previous && previous.key !== info.key) {
            loaded.delete(key)
            ambiguous.add(key)
            problem ??= "unavailable"
          }
          if (!ambiguous.has(key)) loaded.set(key, info)
        })
        if (result.problem || parsed.problem || !parsed.next) break
        if (cursors.has(parsed.next) || page + 1 === ids.length) {
          problem ??= "unavailable"
          break
        }
        cursors.add(parsed.next)
        after = parsed.next
      }
      loaded.forEach((info, key) => found.set(key, info))
    }
  }
  return { issues: found, problem }
}

function lookupID(item: Issue): string | undefined {
  if (item.id !== undefined) return UUID.test(item.id) ? item.id.toLowerCase() : undefined
  const parts = item.key.split(":")
  if (parts.length === 3 && parts[0] === "linear" && UUID.test(parts[1] ?? "") && UUID.test(parts[2] ?? "")) return parts[2]?.toLowerCase()
  return IDENTIFIER.test(item.identifier) ? item.identifier.toUpperCase() : undefined
}

function parseBatch(batch: readonly Issue[], workspace: string, stdout: string): { issues: Map<string, IssueInfo>; problem?: LinearProblem; next?: string } {
  const issues = new Map<string, IssueInfo>()
  const body = json(stdout)
  if (!record(body) || !record(body.data)) return { issues, problem: classify(body) ?? "unavailable" }
  let problem = classify(body)
  const organization = body.data.organization
  if (!record(organization) || typeof organization.id !== "string" || !UUID.test(organization.id)) return { issues, problem: problem ?? "unavailable" }
  if (organization.urlKey !== workspace) return { issues, problem: "workspace" }
  const organizationID = organization.id.toLowerCase()
  const connection = body.data.issues
  if (!record(connection) || !Array.isArray(connection.nodes) || connection.nodes.length > 40) return { issues, problem: problem ?? "unavailable" }
  const candidates = new Map<string, IssueInfo[]>()
  for (const value of connection.nodes) {
    if (record(value) && typeof value.url === "string") {
      const url = issueIn(value.url, 0, {})
      if (url && url.workspace !== workspace) {
        problem ??= "workspace"
        continue
      }
    }
    const info = metadata(value, organizationID, workspace)
    if (!info) {
      problem ??= "unavailable"
      continue
    }
    for (const item of batch) {
      const id = lookupID(item)
      const org = item.key.split(":")[1]
      if (UUID.test(org ?? "") && org?.toLowerCase() !== organizationID) {
        problem ??= "workspace"
        continue
      }
      if (id?.toLowerCase() !== info.id && id !== info.identifier && !info.previousIdentifiers.includes(id ?? "")) continue
      candidates.set(item.key, [...(candidates.get(item.key) ?? []), info])
    }
  }
  candidates.forEach((values, key) => {
    const distinct = new Map(values.map((info) => [info.key, info]))
    if (distinct.size === 1) distinct.forEach((info) => issues.set(key, info))
    else problem ??= "unavailable"
  })
  const pageInfo = connection.pageInfo
  if (!record(pageInfo) || typeof pageInfo.hasNextPage !== "boolean") return { issues, problem: problem ?? "unavailable" }
  if (!pageInfo.hasNextPage) return { issues, problem }
  if (typeof pageInfo.endCursor !== "string" || !pageInfo.endCursor || pageInfo.endCursor.length > 1024) return { issues, problem: problem ?? "unavailable" }
  return { issues, problem, next: pageInfo.endCursor }
}

function metadata(value: unknown, organizationID: string, workspace: string): IssueInfo | undefined {
  if (!record(value) || typeof value.id !== "string" || !UUID.test(value.id) || typeof value.identifier !== "string" || !IDENTIFIER.test(value.identifier)) return undefined
  if (typeof value.title !== "string" || !value.title.trim() || value.title.length > 4096 || typeof value.url !== "string") return undefined
  if (!Array.isArray(value.previousIdentifiers) || value.previousIdentifiers.length > 128 || !value.previousIdentifiers.every((id) => typeof id === "string" && IDENTIFIER.test(id))) return undefined
  const url = issueIn(value.url, 0, {})
  if (!url || url.workspace !== workspace || url.identifier !== value.identifier.toUpperCase()) return undefined
  const state = value.state
  if (!record(state) || typeof state.name !== "string" || !state.name.trim() || state.name.length > 256 || typeof state.type !== "string" || !/^[a-z][a-z_]{0,63}$/.test(state.type) || typeof state.color !== "string" || !/^#[\da-f]{6}$/i.test(state.color)) return undefined
  const id = value.id.toLowerCase()
  return {
    key: `linear:${organizationID}:${id}`,
    id,
    organizationID,
    workspace,
    identifier: value.identifier.toUpperCase(),
    previousIdentifiers: [...new Set(value.previousIdentifiers.map((id: string) => id.toUpperCase()))],
    title: value.title,
    url: url.url,
    state: { name: state.name, type: state.type, color: state.color },
  }
}

async function linear(args: string[], signal?: AbortSignal): Promise<{ stdout: string; problem?: LinearProblem }> {
  const { error, stdout, stderr } = await execCli("linear", args, { timeout: 20_000, maxBuffer: 1024 * 1024, signal })
  if (error?.code === "ENOENT") return { stdout: "", problem: "missing" }
  const problem = classify(json(stdout)) ?? classify(json(stderr)) ?? classifyText(stderr)
  if (!error) return { stdout, problem }
  if (error.name === "AbortError" || error.killed || error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return { stdout: "", problem: "unavailable" }
  return { stdout: stdout || stderr, problem: problem ?? "unavailable" }
}

function classify(value: unknown): LinearProblem | undefined {
  if (!record(value) || !Array.isArray(value.errors) || !value.errors.length) return undefined
  let problem: LinearProblem = "unavailable"
  for (const error of value.errors) {
    if (!record(error)) continue
    const code = record(error.extensions) ? error.extensions.code : undefined
    if (code === "RATELIMITED" || code === "RATE_LIMITED") return "rate-limited"
    if (code === "UNAUTHENTICATED" || code === "AUTHENTICATION_ERROR") problem = "signed-out"
    if (typeof error.message === "string") problem = classifyText(error.message) ?? problem
  }
  return problem
}

function classifyText(text: string): LinearProblem | undefined {
  if (/rate.?limit|too many requests/i.test(text)) return "rate-limited"
  if (/no api key configured|not authenticated|authentication|unauthorized|invalid api key|auth login|\b401\b/i.test(text)) return "signed-out"
  if (/workspace.*(?:not found|unknown|not configured)|(?:unknown|no credentials for).*workspace/i.test(text)) return "workspace"
  return undefined
}

function json(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
