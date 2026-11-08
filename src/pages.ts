import { request as httpRequest, type IncomingMessage } from "node:http"
import { request as httpsRequest } from "node:https"
import type { SessionMessageInfo } from "@opencode/client"
import type { Page as PageSchema } from "./schema.ts"
import { outputText } from "./pulls.ts"
import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { commandIndex, echoOutline, executed, invocation, literal, nestedCommands, opaque, pathText, pureFilter, replays, shellStatements, type Statement } from "./shell.ts"

export type Page = typeof PageSchema.Type

const CANDIDATE = /(?<![a-z0-9])https?:\/\/[^\s`'"<>|]+/gi
const LEGACY_CANDIDATE = /\bhttps?:\/\/[^\s`'"<>|]+/gi
const LOCAL_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|(?:[a-z0-9-]+\.)+localhost)$/

const TRAILING = /[.,;:!?]+$/
const EMPHASIS = /[*_~]+$/
const PAIRS: ReadonlyArray<readonly [string, string]> = [["(", ")"], ["[", "]"]]

export function pagesIn(text: string, created: number): Page[] {
  const pages = new Map<string, Page>()
  const legacy = legacyUrls(text)
  const candidates = new RegExp(CANDIDATE)
  for (let match = candidates.exec(text); match; match = candidates.exec(text)) {
    const before = text.slice(text.lastIndexOf("\n", match.index) + 1, match.index)
    const link = linkText(match[0], before)
    const raw = link === -1 ? match[0] : match[0].slice(0, link)
    if (link !== -1) candidates.lastIndex = match.index + link + 1
    else if (text[match.index + raw.length] === "<") continue
    const end = text.indexOf("\n", match.index)
    const page = toPage(trim(raw, openRuns(before, text.slice(match.index, end === -1 ? undefined : end))), created)
    if (!page) continue
    const old = legacy.get(match.index)
    pages.set(page.url, combine(pages.get(page.url), old && old !== page.url ? withAliases(page, [old]) : page))
  }
  return [...pages.values()]
}

const ANSI = /\x1b\[[\d;?]*[A-Za-z]/g
const LOCAL_LINE = /^[\s\-*•➜>▶|│]*Local:\s+(https?:\/\/\S+?)\/?\s*$/
const PORTLESS_LINE = /^\s*(?:->|→)\s+(https?:\/\/[^\s/]+\.localhost(?::\d+)?(?:\/\S*)?)\s*$/
const PROXIED = /Using port (\d+)|\bPORT=(\d+)\b.*\bPORTLESS_URL=/g
const STREAMING = /^Output is streaming to: (\S+)$/m
const CONTROL = /(?:^|[\s;&|(])(?:if|while|until|case|select|function)\s/
const RUNNERS = new Set(["npm", "pnpm", "yarn", "bun"])
const EXECUTORS = new Set(["npx", "bunx", "pnpx"])
const SCRIPT = /^(?:dev|start|preview|serve)(?::[\w:-]+)?$/
const FRAMEWORKS = new Set(["next", "astro", "nuxt", "nuxi", "remix", "react-router", "storybook", "wrangler"])
const SERVERS = new Set(["http-server", "live-server", "serve", "webpack-dev-server"])
const PORTLESS_TOOLS = new Set(["list", "ls", "proxy", "trust", "stop", "status", "help", "alias", "hosts", "clean", "logs", "version"])
const WRAPPERS = new Set(["nohup", "exec", "time", "command", "caffeinate", "env", "snip"])
const READERS = new Set(["cat", "tail", "head", "less", "sed", "awk", "grep", "egrep", "rg"])
const PATTERNED = new Set(["sed", "awk", "grep", "egrep", "rg"])
const VALUED: Record<string, ReadonlySet<string>> = {
  tail: new Set(["-n", "-c", "--lines", "--bytes"]),
  head: new Set(["-n", "-c", "--lines", "--bytes"]),
  sed: new Set(["-e", "-f"]),
  awk: new Set(["-e", "-f", "-F", "-v"]),
  grep: new Set(["-e", "-f", "-A", "-B", "-C", "-m"]),
  egrep: new Set(["-e", "-f", "-A", "-B", "-C", "-m"]),
  rg: new Set(["-e", "-f", "-A", "-B", "-C", "-m"]),
}

export type ToolCall = { name: string; input: Readonly<Record<string, unknown>>; output: string; created: number }

export function bannersIn(tool: string, input: Readonly<Record<string, unknown>>, output: string, created: number, logs: ReadonlySet<string>, directory?: string): Page[] {
  const pages = rawBanners(tool, input, output, created)
  return pages.length > 0 && provenance(tool, input, logs, directory) ? pages : []
}

export function serverLogs(tool: string, input: Readonly<Record<string, unknown>>, output: string, directory?: string): string[] {
  if (tool !== "shell" || typeof input.command !== "string") return []
  const flat = flatten(input.command, input.workdir, directory)
  if (!flat) return []
  const starts = flat.filter(({ statement, executed }) => executed && startsServer(statement))
  const logs = starts.flatMap(({ statement, cwd }) => [
    ...statement.writes, ...statement.stages.flatMap((words) => words[0] === "tee" ? words.slice(1).filter((word) => !word?.startsWith("-")) : []),
  ].flatMap((path) => resolvePath(cwd, path) ?? []))
  const streamed = STREAMING.exec(output)?.[1]
  if (input.background === true && streamed && starts.length > 0) logs.push(streamed)
  return logs
}

export function pageEvidence(tool: string, input: Readonly<Record<string, unknown>>, output: string): boolean {
  if (rawBanners(tool, input, output, 0).length > 0) return true
  if (tool !== "shell" || typeof input.command !== "string") return false
  return flatten(input.command, input.workdir, undefined)?.some(({ statement, executed }) => executed && startsServer(statement)) ?? false
}

export function pageSources(message: SessionMessageInfo, directory?: string): { pages: Page[]; logs: string[]; tools: ToolCall[] } {
  const pages: Page[] = []
  const logs: string[] = []
  const tools: ToolCall[] = []
  if (message.type !== "assistant") return { pages, logs, tools }
  for (const part of message.content) {
    if (part.type === "text") pages.push(...pagesIn(part.text, message.time.created))
    if (part.type !== "tool" || (part.state.status !== "completed" && part.state.status !== "error")) continue
    const output = outputText(part.state.content ?? [])
    logs.push(...serverLogs(part.name, part.state.input, output, directory))
    if (rawBanners(part.name, part.state.input, output, part.time.created).length > 0)
      tools.push({ name: part.name, input: part.state.input, output, created: part.time.created })
  }
  return { pages, logs, tools }
}

function rawBanners(tool: string, input: Readonly<Record<string, unknown>>, output: string, created: number): Page[] {
  const read = tool === "read" && typeof input.path === "string"
  if (!read && (tool !== "shell" || typeof input.command !== "string")) return []
  const lines = output.replace(ANSI, "").split("\n").map((line) => read ? line.replace(/^\s*\d+:\s?/, "") : line)
  const proxied = new Set([...output.replace(ANSI, "").matchAll(PROXIED)].map((match) => match[1] ?? match[2]))
  const pages = new Map<string, Page>()
  const portless = lines.some((line) => PORTLESS_LINE.test(line))
  const command = read ? "" : String(input.command)
  for (const line of lines) {
    if (command && line.trim() && command.includes(line.trim())) continue
    const raw = PORTLESS_LINE.exec(line)?.[1] ?? LOCAL_LINE.exec(line)?.[1]
    const page = raw === undefined ? undefined : toPage(raw, created)
    if (!page) continue
    if (portless && !PORTLESS_LINE.test(line) && proxied.has(new URL(page.origin).port)) continue
    pages.set(page.url, page)
  }
  return [...pages.values()]
}

function provenance(tool: string, input: Readonly<Record<string, unknown>>, logs: ReadonlySet<string>, directory: string | undefined) {
  if (tool === "read") return typeof input.path === "string" && logs.has(resolvePath(directory, input.path) ?? "")
  if (typeof input.command !== "string") return false
  const flat = flatten(input.command, input.workdir, directory)
  if (!flat) return false
  const known = new Set([...logs, ...serverLogs(tool, input, "", directory)])
  const nested = nestedCommands(input.command).every((body) => shellStatements(body)?.statements.every((statement) => !replays(statement)) ?? false)
  const sources = flat.filter(({ statement, cwd }) => startsServer(statement) || readsLogs(statement, cwd, known))
  return sources.some((entry) => entry.executed) && flat.every((entry) =>
    sources.includes(entry) || !replays(entry.statement) || discards(entry.statement) || (nested && echoOutline(entry.statement)))
}

function discards(statement: Statement) {
  const call = invocation(statement)
  return call?.name === "curl" && statement.stages.length === 0 && call.args.some((arg, at) => (arg === "-o" || arg === "--output") && call.args[at + 1] === "/dev/null")
}

type Entry = { statement: Statement; cwd: string | undefined; executed: boolean }

function flatten(command: string, workdir: unknown, directory: string | undefined) {
  if (CONTROL.test(command)) return undefined
  const top = shellStatements(command)
  if (!top) return undefined
  const flat: Entry[] = []
  const walk = (statements: readonly Statement[], start: string | undefined, reached: boolean) => {
    let cwd = start
    let scoped = false
    statements.forEach((statement, index) => {
      if (scoped && statement.prev !== "and") [cwd, scoped] = [undefined, false]
      const call = invocation(statement)
      const runs = reached && executed(statements, index)
      if (call?.name === "cd" || call?.name === "pushd") {
        const at = commandIndex(statement) + (literal(statement.words[commandIndex(statement)]) === "snip" ? 2 : 1)
        cwd = runs && call.args.length === 1 ? resolvePath(cwd, pathText(statement.words[at])) : undefined
        scoped = cwd !== undefined && statement.prev === "and"
      }
      if (call?.name === "popd" || opaque(statement)) cwd = undefined
      if (statement.inner) {
        const end = walk(statement.inner, cwd, runs)
        if (!statement.subshell) {
          if (end !== undefined && end !== cwd && statement.prev === "and") scoped = true
          cwd = end
        }
      }
      if (!statement.compound) flat.push({ statement, cwd, executed: runs })
    })
    return scoped ? undefined : cwd
  }
  const cwd = walk(top.statements, typeof workdir === "string" ? resolvePath(directory, workdir) : directory, true)
  for (const body of nestedCommands(command)) {
    const inner = shellStatements(body)
    if (!inner) return undefined
    flat.push(...inner.statements.filter((statement) => !statement.compound).map((statement) => ({ statement, cwd, executed: false })))
  }
  return flat
}

function resolvePath(cwd: string | undefined, path: string | undefined) {
  if (path === undefined || /[*?[]/.test(path)) return undefined
  const expanded = path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path
  if (isAbsolute(expanded)) return resolve(expanded)
  return cwd === undefined || path.startsWith("~") ? undefined : resolve(cwd, expanded)
}

function startsServer(statement: Statement) {
  if (statement.compound) return false
  const words = statement.words.map(literal)
  let index = 0
  for (let word = words[0]; word !== undefined; word = words[index]) {
    const name = word.split("/").at(-1) ?? ""
    if (/^[a-z_]\w*=/i.test(word) || WRAPPERS.has(name) || (index > 0 && word.startsWith("-"))) index++
    else if (name === "timeout") index += 2
    else break
  }
  const name = words[index]?.split("/").at(-1)
  const args = words.slice(index + 1)
  if (name === undefined) return false
  if (RUNNERS.has(name)) {
    const exec = args.findIndex((arg) => arg === "exec" || arg === "dlx" || arg === "x")
    if (exec < 0) return args.some((arg) => arg !== undefined && SCRIPT.test(arg))
    const rest = args.slice(exec + 1)
    const at = rest.findIndex((arg) => !arg?.startsWith("-"))
    return serves(rest[at], rest.slice(at + 1))
  }
  if (EXECUTORS.has(name)) {
    const at = args.findIndex((arg) => !arg?.startsWith("-"))
    return serves(args[at], args.slice(at + 1))
  }
  if (name === "python" || name === "python3") return args.some((arg, at) => arg === "-m" && args[at + 1] === "http.server")
  return serves(name, args)
}

function serves(name: string | undefined, args: readonly (string | undefined)[]) {
  const command = name?.split("/").at(-1)
  const sub = args.find((arg) => !arg?.startsWith("-"))
  if (command === undefined) return false
  if (command === "vite" || command === "parcel") return sub === undefined || !/^(?:build|optimize)$/.test(sub)
  if (command === "portless") return sub !== undefined && !PORTLESS_TOOLS.has(sub)
  if (FRAMEWORKS.has(command)) return sub !== undefined && SCRIPT.test(sub)
  return SERVERS.has(command)
}

function readsLogs(statement: Statement, cwd: string | undefined, logs: ReadonlySet<string>) {
  const call = invocation(statement)
  if (!call || !READERS.has(call.name) || !statement.stages.every(pureFilter)) return false
  const files: (string | undefined)[] = []
  let pattern = PATTERNED.has(call.name)
  for (let at = 0; at < call.args.length; at++) {
    const arg = call.args[at]
    if (arg?.startsWith("-") && arg !== "-") {
      if (arg !== undefined && VALUED[call.name]?.has(arg)) {
        if (arg === "-e" || arg === "-f") pattern = false
        at++
      }
      continue
    }
    if (pattern) pattern = false
    else files.push(arg)
  }
  return files.length > 0 && files.every((file) => logs.has(resolvePath(cwd, file) ?? ""))
}

function linkText(candidate: string, before: string) {
  return before.lastIndexOf("[") > before.lastIndexOf("]") ? candidate.indexOf("](") : -1
}

function legacyUrls(text: string) {
  const urls = new Map<number, string>()
  for (const match of text.matchAll(LEGACY_CANDIDATE)) {
    if (text[match.index + match[0].length] === "<") continue
    let value = match[0].replace(TRAILING, "")
    while (value.endsWith(")") && count(value, "(") < count(value, ")")) value = value.slice(0, -1).replace(TRAILING, "")
    const page = toPage(value, 0)
    if (page) urls.set(match.index, page.url)
  }
  return urls
}

function combine(previous: Page | undefined, page: Page) {
  if (!previous) return page
  const created = Math.max(previous.created, page.created)
  return withAliases({ ...page, created }, [...(previous.aliases ?? []), ...(page.aliases ?? [])])
}

function withAliases(page: Page, aliases: readonly string[]): Page {
  const unique = [...new Set(aliases)].filter((alias) => alias !== page.url)
  const base = { url: page.url, origin: page.origin, label: page.label, created: page.created }
  return unique.length ? { ...base, aliases: unique } : base
}

type Run = { readonly char: string; length: number }

function trim(url: string, open: Run[]) {
  let value = url
  for (let previous = ""; previous !== value; ) {
    previous = value
    value = value.replace(TRAILING, "")
    value = value.slice(0, value.length - closer(value, open))
    for (const [start, close] of PAIRS) {
      if (value.endsWith(close) && count(value, start) < count(value, close)) value = value.slice(0, -1)
    }
  }
  return value
}

function closer(value: string, open: Run[]) {
  const run = EMPHASIS.exec(value)?.[0] ?? ""
  for (let start = 0; start < run.length; start++) {
    const stack = open.map((entry) => ({ ...entry }))
    if (!closes(run.slice(start), stack)) continue
    open.splice(0, open.length, ...stack)
    return run.length - start
  }
  return 0
}

function closes(suffix: string, stack: Run[]) {
  for (const group of suffix.match(/([*_~])\1*/g) ?? []) {
    const top = stack.at(-1)
    if (!top || top.char !== group[0] || group.length > top.length) return false
    if (top.char === "~" && group.length !== top.length) return false
    top.length -= group.length
    if (!top.length) stack.pop()
  }
  return true
}

function openRuns(before: string, after: string) {
  const text = neutral(before)
  const stack: Run[] = []
  for (let at = 0; at < text.length; ) {
    const char = text[at] ?? ""
    let end = at + 1
    while (text[end] === char) end++
    if (char === "`") {
      const close = codeEnd(text, at, end)
      if (close === -1 && codeEnd(`${text}${after}`, at, end) !== -1) return []
      at = close === -1 ? end : close
      continue
    }
    if ("*_~".includes(char)) delimiter(stack, char, end - at, text[at - 1], text[end] ?? after[0])
    at = end
  }
  return stack
}

function codeEnd(text: string, start: number, end: number) {
  const fence = text.slice(start, end)
  for (let at = text.indexOf(fence, end); at !== -1; at = text.indexOf(fence, at + 1)) {
    let stop = at + fence.length
    if (text[at - 1] !== "`" && text[stop] !== "`") return stop
    while (text[stop] === "`") stop++
    at = stop - 1
  }
  return -1
}

function delimiter(stack: Run[], char: string, length: number, previous = " ", next = " ") {
  const space = (value: string) => /\s/u.test(value)
  const mark = (value: string) => /[\p{P}\p{S}]/u.test(value)
  const left = !space(next) && (!mark(next) || space(previous) || mark(previous))
  const right = !space(previous) && (!mark(previous) || space(next) || mark(next))
  const canOpen = char === "_" ? left && (!right || mark(previous)) : left
  const canClose = char === "_" ? right && (!left || mark(next)) : right
  let rest = length
  if (canClose) {
    const index = stack.findLastIndex((entry) => entry.char === char)
    const match = stack[index]
    if (match) {
      const used = Math.min(match.length, rest)
      match.length -= used
      rest -= used
      stack.splice(match.length ? index + 1 : index)
    }
  }
  if (canOpen && rest) stack.push({ char, length: rest })
}

function neutral(before: string) {
  let text = ""
  let at = 0
  const candidates = new RegExp(CANDIDATE)
  for (let match = candidates.exec(before); match; match = candidates.exec(before)) {
    const link = linkText(match[0], before.slice(0, match.index))
    const raw = link === -1 ? match[0] : match[0].slice(0, link)
    const tail = /[*_~.,;:!?)\]]*$/.exec(raw)?.[0] ?? ""
    text += `${before.slice(at, match.index)}x${tail}`
    at = match.index + raw.length
    candidates.lastIndex = at
  }
  return text + before.slice(at)
}

function count(value: string, char: string) {
  return value.split(char).length - 1
}

function toPage(raw: string, created: number): Page | undefined {
  try {
    const parsed = new URL(raw)
    if (!LOCAL_HOST.test(parsed.hostname)) return undefined
    const path = parsed.pathname === "/" && !parsed.search && !parsed.hash ? "" : parsed.pathname
    const origin = parsed.origin.toLowerCase()
    const url = `${origin}${path}${parsed.search}${parsed.hash}`
    return { url, origin, label: url.replace(/^https?:\/\//, ""), created }
  } catch {
    return undefined
  }
}

export function mergePages(existing: readonly Page[], found: readonly Page[]): Page[] {
  const byUrl = new Map(existing.map((page) => [page.url, page]))
  for (const page of found) {
    let merged = combine(byUrl.get(page.url), page)
    for (const alias of page.aliases ?? []) {
      const stale = byUrl.get(alias)
      if (!stale) continue
      byUrl.delete(alias)
      merged = combine(stale, merged)
    }
    byUrl.set(page.url, merged)
  }
  return [...byUrl.values()]
}

export type Liveness = "up" | "down" | "unknown"

export function probe(origin: string, signal: AbortSignal): Promise<Liveness> {
  return "Bun" in globalThis ? probeFetch(origin, signal) : probeNode(origin, signal)
}

async function probeFetch(origin: string, signal: AbortSignal): Promise<Liveness> {
  try {
    const response = await fetch(origin, {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
      tls: { rejectUnauthorized: false },
    })
    if (response.status >= 502 && response.status <= 504) return "down"
    if (response.status === 404 && response.headers.has("x-portless")) return "down"
    return "up"
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return "unknown"
    return "down"
  }
}

export function probeNode(origin: string, signal: AbortSignal): Promise<Liveness> {
  return new Promise((resolve) => {
    const options = { method: "HEAD", signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]), rejectUnauthorized: false }
    const done = (response: IncomingMessage) => {
      response.resume()
      const status = response.statusCode ?? 0
      if (status >= 502 && status <= 504) return resolve("down")
      if (status === 404 && response.headers["x-portless"] !== undefined) return resolve("down")
      resolve("up")
    }
    try {
      const request = origin.startsWith("https:") ? httpsRequest(origin, options, done) : httpRequest(origin, options, done)
      request.on("error", (error) => resolve(error.name === "AbortError" ? "unknown" : "down"))
      request.end()
    } catch {
      resolve("down")
    }
  })
}
