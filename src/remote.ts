import { readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"

export type Repo = { readonly host: string; readonly owner: string; readonly repo: string }

const MISS_TTL = 10_000
const found = new Map<string, Repo | undefined>()
const missed = new Map<string, number>()

export function repoAt(directory: string): Repo | undefined {
  const path = directory === "~" ? homedir() : directory.startsWith("~/") ? join(homedir(), directory.slice(2)) : directory
  if (!isAbsolute(path)) return undefined
  const key = resolve(path)
  if (found.has(key)) return found.get(key)
  if (Date.now() - (missed.get(key) ?? 0) < MISS_TTL) return undefined
  const repo = read(key)
  if (repo) found.set(key, repo)
  else missed.set(key, Date.now())
  return repo
}

function read(directory: string): Repo | undefined {
  const config = configOf(directory)
  return config === undefined ? undefined : remoteOf(config)
}

function configOf(directory: string): string | undefined {
  for (let current = directory; ; current = dirname(current)) {
    const dot = join(current, ".git")
    const kind = entry(dot)
    if (kind === "dir") return text(join(dot, "config"))
    if (kind === "file") {
      const pointer = text(dot)?.match(/^gitdir:\s*(.+)$/m)?.[1]?.trim()
      if (!pointer) return undefined
      const gitdir = isAbsolute(pointer) ? pointer : resolve(current, pointer)
      const common = text(join(gitdir, "commondir"))?.trim()
      return text(join(common ? resolve(gitdir, common) : gitdir, "config"))
    }
    if (dirname(current) === current) return undefined
  }
}

export function remoteOf(config: string): Repo | undefined {
  const remotes = new Map<string, { url?: string; resolved?: string }>()
  let section: string | undefined
  for (const raw of config.split("\n")) {
    const line = raw.trim()
    const header = line.match(/^\[\s*remote\s+"([^"]+)"\s*\]$/i)
    if (header) {
      section = header[1]
      continue
    }
    if (line.startsWith("[")) {
      section = undefined
      continue
    }
    const pair = line.match(/^([\w-]+)\s*=\s*(.*)$/)
    if (!section || !pair) continue
    const remote = remotes.get(section) ?? {}
    const name = pair[1]?.toLowerCase()
    if (name === "url") remote.url = pair[2]
    if (name === "gh-resolved") remote.resolved = pair[2]
    remotes.set(section, remote)
  }
  const values = [...remotes.values()]
  const base = values.filter((remote) => remote.resolved === "base")
  if (base.length === 1) return parseRemote(base[0]?.url)
  return values.length === 1 ? parseRemote(values[0]?.url) : undefined
}

export function parseRemote(url: string | undefined): Repo | undefined {
  const match = url?.trim().match(/^(?:(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/|(?:[^@/]+@)?([^/:]+):)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/)
  const host = (match?.[1] ?? match?.[2])?.toLowerCase()
  if (!match || !host?.includes(".")) return undefined
  return { host, owner: match[3]?.toLowerCase() ?? "", repo: match[4]?.toLowerCase() ?? "" }
}

function entry(path: string): "dir" | "file" | undefined {
  try {
    const stat = statSync(path)
    return stat.isDirectory() ? "dir" : stat.isFile() ? "file" : undefined
  } catch {
    return undefined
  }
}

function text(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return undefined
  }
}
