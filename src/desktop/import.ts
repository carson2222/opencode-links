import type { App, Storage } from "@opencode/plugin/gui/main"
import { Exit, Schema } from "effect"
import { readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { initial, type StoreKey } from "../host.ts"
import { schemas } from "../schema.ts"

const KEYS = ["chats", "status", "linear", "hidden"] as const satisfies readonly StoreKey[]

export function tuiDirectories(env: Readonly<Record<string, string | undefined>>, channel: App["channel"]) {
  const state = env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state")
  const channels = [...new Set([channel === "prod" ? "latest" : channel, "latest"])]
  return channels.map((name) => path.join(state, "opencode", name, "tui"))
}

export function importTuiCache(storage: Pick<Storage, "store">, directories: readonly string[]) {
  const done = storage.store("imported", { schema: Schema.Boolean, initial: false })
  if (done.value) return []
  const imported = KEYS.filter((key) => copy(storage, directories, key))
  done.set(true)
  return imported
}

function copy<K extends (typeof KEYS)[number]>(storage: Pick<Storage, "store">, directories: readonly string[], key: K) {
  const store = storage.store(key, { schema: schemas[key], initial: initial(key) })
  if (JSON.stringify(store.value) !== JSON.stringify(initial(key))) return false
  const codec = Schema.toCodecJson(schemas[key])
  for (const directory of directories) {
    const raw = read(path.join(directory, `plugin.opencode-links.${key}.json`))
    if (raw === undefined) continue
    const decoded = Schema.decodeUnknownExit(codec)(raw)
    if (Exit.isFailure(decoded)) continue
    store.set(decoded.value)
    return true
  }
  return false
}

function read(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return undefined
  }
}
