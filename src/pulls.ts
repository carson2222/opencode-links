import type { SessionMessageInfo, ToolTextContent } from "@opencode/client"
import type { Pull as PullSchema } from "./schema.ts"
import { andToEnd, commandIndex, controls, echoOutline, executed, exitUnknown, invocation, literal, nestedCommands, opaque, overrides, pathText, replays, shellStatements, type Statement } from "./shell.ts"

export type Pull = typeof PullSchema.Type

const CREATE = /(?:^|[\n;&|(]|\$\()[ \t]*(?:\w+=\S*[ \t]+)*(?:\S*\/)?(?:snip[ \t]+)?gh[ \t]+pr[ \t]+create(?=[\s;&|)]|$)/
const URL_LINE = /^[ \t]*https:\/\/([\w.-]+)\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)[ \t]*$/gm

const HEREDOC = /<<-?[ \t]*(['"]?)(\w+)\1([^\n]*)\n[\s\S]*?(?:\n[ \t]*\2[ \t]*(?=\n|$)|$)/g
const QUOTED = /\$'(?:\\.|[^'\\])*'|'[^']*'|"(?:\\.|[^"\\])*"/g
const SUBSTITUTION = /(?<!\\)(?:\\\\)*(\$\([^)]*\))/g

export function createsPull(command: string) {
  const bare = command
    .replace(HEREDOC, "$3\n")
    .replace(QUOTED, (quoted) =>
      quoted.startsWith('"') ? ` ${[...quoted.matchAll(SUBSTITUTION)].map((match) => match[1]).join(" ")} ` : " ",
    )
  return CREATE.test(bare)
}

export type PullTarget = { readonly number?: number; readonly host?: string; readonly owner?: string; readonly repo?: string }
export type Locate = (directory: string) => { readonly host: string; readonly owner: string; readonly repo: string } | undefined
export type Place = { readonly cwd?: string; readonly locate?: Locate }

type Verb = "create" | "merge" | "close" | "ready" | "reopen" | "edit" | "comment" | "review" | "checkout" | "view" | "checks"
type PullCommand = { verb: Verb; target: PullTarget; args: readonly (string | undefined)[]; json?: string; help: boolean; at: number; stage: number; statement: Statement; cwd?: string; visible: boolean }

const PULL_URL = /^https:\/\/([\w.-]+)\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#]\S*)?$/
const BODY = ["-b", "--body", "-F", "--body-file"]
const OUTPUT = ["--json", "-q", "--jq", "-t", "--template"]
const VALUES: Record<Verb, ReadonlySet<string>> = {
  create: new Set([...BODY, "-t", "--title", "-B", "--base", "-H", "--head", "-a", "--assignee", "-r", "--reviewer", "-l", "--label", "-m", "--milestone", "-p", "--project", "-T", "--template", "--recover"]),
  merge: new Set([...BODY, "-t", "--subject", "-A", "--author-email", "--match-head-commit"]),
  close: new Set(["-c", "--comment"]),
  reopen: new Set(["-c", "--comment"]),
  ready: new Set(),
  edit: new Set([
    ...BODY, "-t", "--title", "-B", "--base", "-m", "--milestone", "--add-label", "--remove-label", "--add-reviewer",
    "--remove-reviewer", "--add-assignee", "--remove-assignee", "--add-project", "--remove-project",
  ]),
  comment: new Set(BODY),
  review: new Set(BODY),
  checkout: new Set(["-b", "--branch"]),
  view: new Set(OUTPUT),
  checks: new Set([...OUTPUT, "-i", "--interval"]),
}
const CHANGES: ReadonlySet<Verb> = new Set(["merge", "close", "ready", "reopen", "edit", "comment", "review"])
const WORK: ReadonlySet<Verb> = new Set([...CHANGES, "checkout"])
const STATUS = /\b(?:statusCheckRollup|reviewDecision|mergeStateStatus|reviews|latestReviews|reviewRequests)\b/
const BULK = 3
const NO_URL = /^(?:--web|--dry-run|-[^-]*w)$/
const TRUNCATED = /^\[showing lines \d+-\d+ of \d+; full output saved to /m

function pullCommands(command: string, place: Place = {}, deep = false): { statements: Statement[]; pulls: PullCommand[] } {
  const statements = shellStatements(command)?.statements ?? []
  const pulls: PullCommand[] = []
  const walk = (list: readonly Statement[], start: string | undefined, reached: boolean, shown: boolean) => {
    let cwd = start
    let scoped = false
    list.forEach((statement, at) => {
      if (scoped && statement.prev !== "and") [cwd, scoped] = [undefined, false]
      const call = invocation(statement)
      const runs = reached && executed(list, at)
      if (call?.name === "cd" || call?.name === "pushd") {
        const index = commandIndex(statement) + (literal(statement.words[commandIndex(statement)]) === "snip" ? 2 : 1)
        const args = statement.words.slice(index)
        cwd = !runs || args.length > 1 || call.args[0] === "-" ? undefined : args.length === 0 ? "~" : moveTo(cwd, pathText(args[0]))
        scoped = cwd !== undefined && statement.prev === "and"
        return
      }
      if (call?.name === "popd" || opaque(statement)) cwd = undefined
      if (statement.inner && deep) {
        const end = walk(statement.inner, cwd, runs, shown && statement.visible)
        if (!statement.subshell) {
          if (end !== undefined && end !== cwd && statement.prev === "and") scoped = true
          cwd = end
        }
      }
      if (statement.compound) return
      ;[statement.words.map(literal), ...statement.stages].forEach((words, stage) => {
        const pull = ghPull(words)
        if (pull) pulls.push({ ...pull, at, stage, statement, cwd, visible: shown && statement.visible })
      })
    })
    return scoped ? undefined : cwd
  }
  walk(statements, place.cwd, true, true)
  return { statements, pulls }
}

export function moveTo(cwd: string | undefined, target: string | undefined) {
  if (target === undefined || (target.startsWith("~") && target !== "~" && !target.startsWith("~/"))) return undefined
  if (target.startsWith("/") || target.startsWith("~")) return target
  return cwd === undefined ? undefined : `${cwd.replace(/\/$/, "")}/${target}`
}

function ghPull(words: readonly (string | undefined)[]): Omit<PullCommand, "at" | "stage" | "statement" | "cwd" | "visible"> | undefined {
  const env = new Map<string, string>()
  let index = 0
  for (let word = words[0]; word !== undefined && /^[a-z_]\w*=/i.test(word); word = words[++index])
    env.set(word.slice(0, word.indexOf("=")), word.slice(word.indexOf("=") + 1))
  if (words[index] === "snip") index++
  if (!/^(?:\S*\/)?gh$/.test(words[index] ?? "") || words[index + 1] !== "pr") return undefined
  const verb = words[index + 2]
  if (!isVerb(verb)) return undefined
  const values = VALUES[verb]
  let repo = env.get("GH_REPO")
  let positional: string | undefined | null = null
  let json: string | undefined
  let help = false
  const rest = words.slice(index + 3)
  for (let at = 0; at < rest.length; at++) {
    const token = rest[at]
    if (token === undefined) {
      if (positional === null) positional = undefined
      continue
    }
    if (token === "-R" || token === "--repo") { repo = rest[++at]; continue }
    if (token.startsWith("--repo=")) { repo = token.slice(7); continue }
    if (/^-R[^-]/.test(token)) { repo = token.slice(2); continue }
    if (token === "--json") { json = rest[++at] ?? ""; continue }
    if (token.startsWith("--json=")) { json = token.slice(7); continue }
    if (token === "-h" || token === "--help") help = true
    if (token.startsWith("-")) { if (!token.includes("=") && values.has(token)) at++; continue }
    if (positional === null) positional = token
  }
  const base = { verb, args: rest, json, help }
  const url = positional?.match(PULL_URL)
  if (url) return { ...base, target: { host: url[1]?.toLowerCase(), owner: url[2]?.toLowerCase(), repo: url[3]?.toLowerCase(), number: Number(url[4]) } }
  const parts = repo?.replace(/^https:\/\//, "").replace(/\/$/, "").toLowerCase().split("/") ?? []
  const scope = parts.length === 2 ? { owner: parts[0], repo: parts[1] }
    : parts.length === 3 ? { host: parts[0], owner: parts[1], repo: parts[2] } : {}
  const number = positional?.match(/^#?(\d+)$/)?.[1]
  return { ...base, target: { ...scope, ...(number ? { number: Number(number) } : {}) } }
}

function isVerb(value: string | undefined): value is Verb {
  return value !== undefined && Object.hasOwn(VALUES, value)
}

export function pullChanges(command: string): PullTarget[] {
  const inner = nestedCommands(command).flatMap((body) => pullCommands(body).pulls)
  return [...pullCommands(command).pulls, ...inner].filter((pull) => CHANGES.has(pull.verb) && !pull.help).map((pull) => pull.target)
}

export function pullsWorked(command: string, created: number, place: Place = {}): Pull[] {
  const { pulls } = pullCommands(command, place, true)
  const watched = pulls.filter(monitoring)
  const monitors = new Set(watched.map((pull) => {
    const target = resolveTarget(pull.target, pull.cwd, place.locate)
    return target ? keyOf(target) : `${pull.at}:${pull.stage}`
  })).size
  const uses = pulls.flatMap((pull) => {
    if (pull.help || pull.statement.binding) return []
    const work = WORK.has(pull.verb)
    if (!work && !monitoring(pull)) return []
    const target = resolveTarget(pull.target, pull.cwd, place.locate)
    return target ? [{ target, work }] : []
  })
  return mergePulls([], uses.filter((use) => use.work || monitors <= BULK).map((use) => toPull(use.target, created)))
}

function replayFree(command: string, statements: readonly Statement[], own: ReadonlySet<number>) {
  const nested = nestedCommands(command).every((body) => shellStatements(body)?.statements.every((statement) => !replays(statement)) ?? false)
  return statements.every((statement, index) => own.has(index) || !replays(statement) || (nested && echoOutline(statement)))
}

function monitoring(pull: PullCommand) {
  return (pull.verb === "checks" || (pull.verb === "view" && STATUS.test(pull.json ?? ""))) && pull.visible && pull.stage === 0
}

function resolveTarget(target: PullTarget, cwd: string | undefined, locate: Locate | undefined) {
  if (target.number === undefined) return undefined
  if (target.owner !== undefined && target.repo !== undefined) return { host: target.host ?? "github.com", owner: target.owner, repo: target.repo, number: target.number }
  const found = cwd === undefined ? undefined : locate?.(cwd)
  return found ? { ...found, number: target.number } : undefined
}

type Resolved = { host: string; owner: string; repo: string; number: number }

function keyOf(target: Resolved) {
  return `${target.host}/${target.owner}/${target.repo}#${target.number}`.toLowerCase()
}

function toPull(target: Resolved, created: number): Pull {
  return { key: keyOf(target), url: `https://${target.host}/${target.owner}/${target.repo}/pull/${target.number}`, host: target.host, owner: target.owner, repo: target.repo, number: target.number, created }
}

export function targets(pull: Pull, target: PullTarget, merged: boolean) {
  if (target.number === undefined ? merged : pull.number !== target.number) return false
  if (target.owner !== undefined && (pull.owner.toLowerCase() !== target.owner || pull.repo.toLowerCase() !== target.repo)) return false
  return target.host === undefined || pull.host.toLowerCase() === target.host
}

export function pullsIn(output: string, created: number): Pull[] {
  return [...output.matchAll(URL_LINE)].map(([, host = "", owner = "", repo = "", number = ""]) => toPull({ host, owner, repo, number: Number(number) }, created))
}

export function pullsFromTool(command: string, output: string, exit: unknown, created: number, place: Place = {}): Pull[] {
  return mergePulls(createdPulls(command, output, exit, created).pulls, pullsWorked(command, created, place))
}

export function createdPulls(command: string, output: string, exit: unknown, created: number): { pulls: Pull[]; proven: ReadonlySet<number> } {
  const none = { pulls: [], proven: new Set<number>() }
  if (exit !== 0 || !createsPull(command)) return none
  const { statements, pulls } = pullCommands(command)
  const creates = pulls.filter((pull) => pull.verb === "create" && !pull.help && !pull.statement.binding)
  const shown = pullsIn(output, created).filter((pull) => !command.includes(pull.url))
  if (shown.length === 0) return none
  const decided = creates.filter((pull) => !exitUnknown(pull.statement) && andToEnd(statements, pull.at) && pull.stage === pull.statement.stages.length)
  if (replayFree(command, statements, new Set(creates.map((pull) => pull.at)))) {
    const proven = creates.length === 1 || new Set(shown.map((pull) => pull.key)).size === creates.length ? creates : decided
    return proven.length > 0 ? { pulls: shown, proven: new Set(proven.map((pull) => pull.at)) } : none
  }
  const own = decided.find(({ statement, stage, target, args }) => stage === 0 && statement.out === "out" && !args.some((arg) => arg === undefined || NO_URL.test(arg)) &&
    shown.every((pull) => target.owner === undefined || (pull.owner.toLowerCase() === target.owner && pull.repo.toLowerCase() === target.repo)))
  const unique = new Set(shown.map((pull) => pull.key)).size === 1
  if (!own || !unique || TRUNCATED.test(output) || statements.some((statement) => controls(statement) || overrides(statement) || statement.link === "background")) return none
  return { pulls: shown.slice(0, 1), proven: new Set([own.at]) }
}

export function pullsFromMessage(message: SessionMessageInfo, place: Place = {}): Pull[] {
  if (message.type !== "assistant") return []
  return message.content.flatMap((part) => {
    if (part.type !== "tool" || part.name !== "shell" || (part.state.status !== "completed" && part.state.status !== "error")) return []
    const { command, workdir } = part.state.input
    if (typeof command !== "string") return []
    const cwd = typeof workdir === "string" && workdir ? moveTo(place.cwd, workdir) : place.cwd
    if (part.state.status === "error") return launched(part.state.metadata) ? pullsWorked(command, part.time.created, { ...place, cwd }) : []
    return pullsFromTool(command, outputText(part.state.content), part.state.metadata?.exit, part.time.created, { ...place, cwd })
  })
}

export function launched(metadata: Readonly<Record<string, unknown>> | undefined): boolean {
  return typeof metadata?.shellID === "string" && metadata.shellID !== ""
}

export function pullsInUser(text: string, created: number): Pull[] {
  return mergePulls([], [...text.matchAll(/https:\/\/([\w.-]+)\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?!\w)/g)].map(([, host = "", owner = "", repo = "", number = ""]) =>
    toPull({ host: host.toLowerCase(), owner: owner.toLowerCase(), repo: repo.toLowerCase(), number: Number(number) }, created)))
}

export function outputText(content: ReadonlyArray<ToolTextContent | { readonly type: "file" }>) {
  return content.map((item) => (item.type === "text" ? item.text : "")).join("\n")
}

export function mergePulls(existing: readonly Pull[], found: readonly Pull[]): Pull[] {
  const known = new Set(existing.map((pull) => pull.key))
  const added = found.filter((pull) => {
    if (known.has(pull.key)) return false
    known.add(pull.key)
    return true
  })
  return [...existing, ...added]
}

export function cleanTitle(title: string) {
  const bare = title.replace(/^[a-z]+(?:\([^)]*\))?!?:\s+/i, "").trim()
  return bare.charAt(0).toUpperCase() + bare.slice(1)
}

export function fit(text: string, width: number) {
  if (width <= 0) return ""
  if (text.length <= width) return text
  return text.slice(0, width - 1).trimEnd() + "…"
}

export function scroll(text: string, width: number, offset: number) {
  if (text.length <= width) return text
  const loop = `${text}   `
  return Array.from({ length: width }, (_, index) => loop[(offset + index) % loop.length]).join("")
}
