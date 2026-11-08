import { execCli } from "./cli.ts"
import type { Pull } from "./pulls.ts"
import type { Problem as ProblemSchema, PullState } from "./schema.ts"

export type State = typeof PullState.Type
export type Status = { readonly title: string; readonly state: State }
type Problem = Exclude<typeof ProblemSchema.Type, "workspace">
type Statuses = { statuses: Map<string, Status>; failed: Set<string>; problem?: Problem; reset?: number }

const BATCH = 40
const RANK: Record<Problem, number> = { unavailable: 0, "rate-limited": 1, "signed-out": 2, missing: 3 }

export function query(pulls: readonly Pull[]) {
  const fields = pulls.map(
    (pull, index) =>
      `p${index}: repository(owner: ${JSON.stringify(pull.owner)}, name: ${JSON.stringify(pull.repo)}) { pullRequest(number: ${pull.number}) { title state isDraft } }`,
  )
  return `query { ${fields.join(" ")} }`
}

export function parse(pulls: readonly Pull[], stdout: string, exit = 0, now = Date.now()): Statuses {
  const statuses = new Map<string, Status>()
  const all = () => new Set(pulls.map((pull) => pull.key))
  const { status, headers, text } = split(stdout)
  let body: unknown
  try { body = JSON.parse(text) } catch { body = undefined }
  const errors = isRecord(body) && Array.isArray(body.errors) ? body.errors.filter(isRecord) : []
  if (status === 429 || (status === 403 && (headers.get("x-ratelimit-remaining") === "0" || headers.has("retry-after") || /rate limit/i.test(text)))
    || errors.some((error) => error.type === "RATE_LIMITED")) {
    const retry = Number(headers.get("retry-after"))
    const epoch = Number(headers.get("x-ratelimit-reset"))
    const reset = retry > 0 ? now + retry * 1000 : epoch > 0 ? epoch * 1000 : undefined
    return { statuses, failed: all(), problem: "rate-limited", ...(reset ? { reset } : {}) }
  }
  if (status === 401) return { statuses, failed: all(), problem: "signed-out" }
  if ((status ?? 0) >= 400 || !isRecord(body) || !isRecord(body.data) || (exit !== 0 && errors.length === 0))
    return { statuses, failed: all(), problem: "unavailable" }
  const data = body.data
  const absent = new Set<string>()
  const broken = new Set<string>()
  let unscoped = false
  for (const error of errors) {
    const alias = Array.isArray(error.path) && typeof error.path[0] === "string" ? error.path[0] : undefined
    if (alias === undefined) unscoped = true
    else (error.type === "NOT_FOUND" ? absent : broken).add(alias)
  }
  const failed = new Set<string>()
  pulls.forEach((pull, index) => {
    const alias = `p${index}`
    if (broken.has(alias)) return failed.add(pull.key)
    const repository = data[alias]
    const node = isRecord(repository) ? repository.pullRequest : undefined
    const state = isRecord(node) ? toState(node.state, node.isDraft) : undefined
    if (isRecord(node) && typeof node.title === "string" && state) return statuses.set(pull.key, { title: node.title, state })
    if (absent.has(alias) || (!unscoped && (repository === null || (isRecord(repository) && repository.pullRequest === null)))) return
    failed.add(pull.key)
  })
  return { statuses, failed, ...(failed.size > 0 ? { problem: "unavailable" as const } : {}) }
}

export async function fetchStatuses(pulls: readonly Pull[], signal?: AbortSignal, sent?: () => void): Promise<Statuses> {
  const result: Statuses = { statuses: new Map(), failed: new Set() }
  for (const [host, group] of Map.groupBy(pulls, (pull) => pull.host)) {
    for (let start = 0; start < group.length; start += BATCH) {
      const batch = group.slice(start, start + BATCH)
      sent?.()
      const output = await gh(["api", "graphql", "--include", "--hostname", host, "-f", `query=${query(batch)}`], signal)
      const parsed: Statuses = output.problem
        ? { statuses: new Map(), failed: new Set(batch.map((pull) => pull.key)), problem: output.problem }
        : parse(batch, output.stdout, output.exit)
      parsed.statuses.forEach((status, key) => result.statuses.set(key, status))
      parsed.failed.forEach((key) => result.failed.add(key))
      if (parsed.problem && (!result.problem || RANK[parsed.problem] > RANK[result.problem])) result.problem = parsed.problem
      if (parsed.reset) result.reset = Math.max(result.reset ?? 0, parsed.reset)
    }
  }
  return result
}

async function gh(args: string[], signal?: AbortSignal): Promise<{ stdout: string; exit: number; problem?: Problem }> {
  const { error, stdout } = await execCli("gh", args, { timeout: 20_000, maxBuffer: 1024 * 1024, signal })
  if (!error) return { stdout, exit: 0 }
  if (error.code === "ENOENT") return { stdout: "", exit: -1, problem: "missing" }
  if (error.code === 4) return { stdout: "", exit: 4, problem: "signed-out" }
  if (typeof error.code !== "number" || error.killed) return { stdout: "", exit: -1, problem: "unavailable" }
  return { stdout, exit: error.code }
}

function split(stdout: string) {
  const headers = new Map<string, string>()
  if (!stdout.startsWith("HTTP/")) return { status: undefined, headers, text: stdout }
  const end = stdout.search(/\r?\n\r?\n/)
  const head = end < 0 ? stdout : stdout.slice(0, end)
  const [line = "", ...rest] = head.split(/\r?\n/)
  for (const header of rest) {
    const colon = header.indexOf(":")
    if (colon > 0) headers.set(header.slice(0, colon).trim().toLowerCase(), header.slice(colon + 1).trim())
  }
  const status = Number(line.split(" ")[1])
  return { status: Number.isFinite(status) ? status : undefined, headers, text: end < 0 ? "" : stdout.slice(end).trim() }
}

function toState(state: unknown, draft: unknown): State | undefined {
  if (state === "MERGED") return "merged"
  if (state === "CLOSED") return "closed"
  if (state === "OPEN") return draft === true ? "draft" : "open"
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
