import type { SessionInfo } from "@opencode/client"
import { isDeepStrictEqual } from "node:util"
import { bannersIn, mergePages, pageEvidence, pageSources, pagesIn, probe, serverLogs, type Liveness, type Page, type ToolCall } from "./pages.ts"
import { fetchStatuses, type State } from "./github.ts"
import { launched, mergePulls, moveTo, outputText, pullChanges, pullsFromMessage, pullsFromTool, pullsInUser, pullsWorked, targets, type Place, type Pull } from "./pulls.ts"
import { repoAt } from "./remote.ts"
import { createHidden, type Hidden } from "./hidden.ts"
import { createRefresher, type RefreshOptions } from "./provider.ts"
import type { Stats } from "./stats.ts"
import type { Viewed } from "./viewed.ts"
import type { Extension } from "./extension.ts"
import type { Host } from "./host.ts"
import type { Chat as ChatSchema, Checkpoint as CheckpointSchema } from "./schema.ts"

type Checkpoint = typeof CheckpointSchema.Type
type Chat = typeof ChatSchema.Type

const FIRST_PAGE = 10
const PAGE = 100
const RECENT = 50
const BURST = [0, 15_000, 30_000, 60_000, 120_000]
const ASYNC = /\bgh[ \t]+pr[ \t]+(?:ready\b|merge\b)/
const LINEAR_AFTER_PULL = [3_000, 15_000]
const DEPTH = 64
const FORGET = 90 * 24 * 60 * 60_000
const RETOUCH = 60 * 60_000
const PROBE_TTL = 10_000
const ABSENT_AFTER = 10 * 60_000
const PAGES_VERSION = 4
const LOGS = 50
const PULLS_VERSION = 4
const PULLS_USER_VERSION = 1

export function createTracker<Reference = never>(
  host: Host,
  ceiling?: number,
  extension?: Extension<Reference>,
  hidden: Hidden = createHidden(host),
  extra: { stats?: Stats; viewed?: Viewed } = {},
) {
  const chatStore = host.store("chats")
  const knownStore = host.store("status")
  const scans = new Map<string, Promise<boolean>>()
  const queued = new Map<string, AbortSignal>()
  const abort = new AbortController()
  let probing: Promise<void> | undefined
  const pending = new Set<string>()
  let unresolved = 0
  const scanned = new Map<string, number>()
  const liveness = host.memory<Record<string, Liveness>>({})
  const probed = new Map<string, number>()
  const sessionOf = host.session

  async function rootOf(sessionID: string) {
    let id = sessionID
    const seen = new Set<string>()
    while (seen.size < DEPTH && !seen.has(id)) {
      seen.add(id)
      const session = await sessionOf(id)
      if (!session.parentID) return id
      id = session.parentID
    }
    throw new Error("Chat root not found")
  }

  function placeOf(session: SessionInfo, workdir?: unknown): Place {
    const directory = session.location?.directory
    return { cwd: typeof workdir === "string" && workdir ? moveTo(directory, workdir) : directory, locate: repoAt }
  }

  function retry(sessionID: string) {
    void rootOf(sessionID).then((rootID) => { pending.add(rootID) }, () => { unresolved = Date.now() })
  }

  async function scanSession(session: SessionInfo, since: number, extraSince: number, pagesSince: number | undefined, signal: AbortSignal) {
    const found: Pull[] = []
    const pages: Page[] = []
    const logs: string[] = []
    const tools: ToolCall[] = []
    const extra: Reference[] = []
    let mark = since
    let extraMark = extraSince
    let floor = Number.POSITIVE_INFINITY
    let cursor: string | undefined
    while (!signal.aborted) {
      const page = await host.client().message.list(
        cursor
          ? { sessionID: session.id, type: "assistant", limit: PAGE, cursor }
          : { sessionID: session.id, type: "assistant", limit: FIRST_PAGE, order: "desc" },
        { signal },
      )
      let done = false
      for (const message of page.data) {
        const created = message.time.created
        if (created < Math.min(since, extraSince, pagesSince ?? Number.POSITIVE_INFINITY) || created < session.time.created) {
          done = true
          break
        }
        mark = Math.max(mark, created)
        extraMark = Math.max(extraMark, created)
        if (message.type === "assistant" && message.time.completed === undefined) floor = Math.min(floor, created - 1)
        if (created >= since) found.push(...pullsFromMessage(message, placeOf(session)))
        if (created >= extraSince && extension) extra.push(...extension.assistant(message))
        if (pagesSince !== undefined && created >= pagesSince) {
          const sources = pageSources(message, session.location?.directory)
          pages.push(...sources.pages)
          logs.push(...sources.logs)
          tools.push(...sources.tools)
        }
      }
      cursor = page.cursor.next ?? undefined
      if (done || !cursor || page.data.length === 0) break
    }
    const known = new Set([...chatStore.value.byRoot[session.id]?.logs ?? [], ...logs])
    for (const call of tools) pages.push(...bannersIn(call.name, call.input, call.output, call.created, known, session.location?.directory))
    return {
      found, pages, logs, extra,
      mark: Math.max(since, Math.min(mark, floor)),
      extraMark: Math.max(extraSince, Math.min(extraMark, floor)),
    }
  }

  async function childrenOf(parentID: string, signal: AbortSignal) {
    const children: SessionInfo[] = []
    let cursor: string | undefined
    while (!signal.aborted) {
      const page = await host.client().session.list(
        cursor ? { parentID, limit: PAGE, cursor } : { parentID, limit: PAGE, order: "desc" },
        { signal },
      )
      children.push(...page.data)
      cursor = page.cursor.next ?? undefined
      if (!cursor || page.data.length === 0) break
    }
    return children
  }

  async function descendantsOf(rootID: string, signal: AbortSignal) {
    const seen = new Set([rootID])
    const found: SessionInfo[] = []
    let level = [rootID]
    while (level.length > 0 && !signal.aborted) {
      const next: string[] = []
      for (let start = 0; start < level.length && !signal.aborted; start += 4) {
        const pages = await Promise.all(level.slice(start, start + 4).map((id) => childrenOf(id, signal)))
        for (const child of pages.flat()) {
          if (seen.has(child.id)) continue
          seen.add(child.id)
          found.push(child)
          next.push(child.id)
        }
      }
      level = next
    }
    return found
  }

  async function scanRoot(rootID: string, signal: AbortSignal) {
    const root = await host.client().session.get({ sessionID: rootID }, { signal })
    if (signal.aborted) return
    if (chatStore.value.byRoot[rootID]) await saveProgress(rootID, [], [], {})
    await extension?.save(rootID, [])
    if (!signal.aborted) await scanUsers(root, signal)
    const sessions = [root, ...(await descendantsOf(rootID, signal))]
    let failed = false
    for (let start = 0; start < sessions.length; start += 4) {
      if (signal.aborted) return
      const results = await Promise.allSettled(
        sessions.slice(start, start + 4).map(async (session) => {
          const previous = chatStore.value.byRoot[rootID]?.checkpoints?.[session.id]
          const mark = typeof previous === "number" ? previous : previous?.mark ?? 0
          const idle = session.time.idle
          const settled = idle !== undefined && idle >= session.time.updated
          const current = !extension || (typeof previous === "object" && previous.version === extension.version)
          const withPages = session.id === rootID
          const pagesCurrent = !withPages || (typeof previous === "object" && previous.pagesVersion === PAGES_VERSION)
          const pullsCurrent = typeof previous === "object" && previous.pullsVersion === PULLS_VERSION
          if (typeof previous === "object" && settled && previous.idle === idle && current && pagesCurrent && pullsCurrent && (!extension || previous.extraIdle === idle)) return undefined
          const since = pullsCurrent ? mark : 0
          const extraSince = extension && typeof previous === "object" && current ? previous.extraMark ?? 0 : extension ? 0 : since
          const result = await scanSession(session, since, extraSince, withPages ? pagesCurrent ? mark : 0 : undefined, signal)
          return { sessionID: session.id, idle: settled ? idle : undefined, pagesVersion: withPages ? PAGES_VERSION : undefined, ...result }
        }),
      )
      const found: Pull[] = []
      const pages: Page[] = []
      const logs: string[] = []
      const extra: Reference[] = []
      const checkpoints: Record<string, Checkpoint> = {}
      for (const outcome of results) {
        if (outcome.status === "rejected") { failed = true; continue }
        const result = outcome.value
        if (!result) continue
        found.push(...result.found)
        pages.push(...result.pages)
        logs.push(...result.logs)
        extra.push(...result.extra)
        checkpoints[result.sessionID] = {
          mark: result.mark, idle: result.idle, pullsVersion: PULLS_VERSION,
          ...(result.pagesVersion ? { pagesVersion: result.pagesVersion } : {}),
          extraMark: extension ? result.extraMark : undefined,
          extraIdle: extension ? result.idle : undefined,
          version: extension?.version,
        }
      }
      if (signal.aborted) return
      if (extension && extra.length > 0) await extension.save(rootID, extra)
      if (signal.aborted) return
      if (Object.keys(checkpoints).length > 0) await saveProgress(rootID, found, pages, checkpoints, {}, logs)
    }
    if (failed) throw new Error("History read failed")
  }

  async function scanUsers(root: SessionInfo, signal: AbortSignal) {
    const chat = chatStore.value.byRoot[root.id]
    const idle = root.time.idle
    const settled = idle !== undefined && idle >= root.time.updated
    const stream = (previous: Checkpoint | undefined, version: number) => {
      const current = previous?.version === version
      return { version, since: current ? previous.mark : 0, done: current && settled && previous.idle === idle }
    }
    const linear = extension ? stream(chat?.userCheckpoint, extension.userVersion ?? extension.version) : undefined
    const pulls = stream(chat?.pullsUserCheckpoint, PULLS_USER_VERSION)
    const readLinear = linear !== undefined && !linear.done
    if (!readLinear && pulls.done) return
    const since = Math.min(readLinear ? linear.since : Number.POSITIVE_INFINITY, pulls.done ? Number.POSITIVE_INFINITY : pulls.since)
    let cursor: string | undefined
    let mark = since
    while (!signal.aborted) {
      const page = await host.client().message.list({
        sessionID: root.id, type: "user", limit: RECENT, ...(cursor ? { cursor } : { order: "desc" }),
      }, { signal })
      const found: Reference[] = []
      const requested: Pull[] = []
      let done = false
      for (const message of page.data) {
        if (message.time.created < since || message.time.created < root.time.created) { done = true; break }
        mark = Math.max(mark, message.time.created)
        if (message.type !== "user") continue
        if (readLinear && extension && message.time.created >= linear.since) found.push(...extension.user(message.text, message.time.created))
        if (!pulls.done && message.time.created >= pulls.since) requested.push(...pullsInUser(message.text, message.time.created))
      }
      if (signal.aborted) return
      if (extension && found.length > 0) await extension.save(root.id, found)
      if (requested.length > 0) await saveProgress(root.id, requested, [], {})
      cursor = page.cursor.next ?? undefined
      if (done || !cursor || page.data.length === 0) break
    }
    if (signal.aborted) return
    const checkpoint = (version: number) => ({ mark, version, idle: settled ? idle : undefined })
    await saveProgress(root.id, [], [], {}, {
      ...(readLinear ? { linear: checkpoint(linear.version) } : {}),
      ...(pulls.done ? {} : { pulls: checkpoint(pulls.version) }),
    })
  }

  async function saveProgress(
    rootID: string, found: Pull[], pages: Page[], checkpoints: Record<string, Checkpoint>,
    users: { linear?: Checkpoint; pulls?: Checkpoint } = {}, logs: readonly string[] = [],
  ) {
    if (abort.signal.aborted) return
    await saveChat(rootID, (previous, touched) => {
      const merged = { ...previous?.checkpoints }
      for (const [sessionID, checkpoint] of Object.entries(checkpoints)) {
        const old = merged[sessionID]
        const mark = typeof old === "number" ? old : old?.mark ?? 0
        const idle = typeof old === "object" ? old.idle : undefined
        const version = Math.max(typeof old === "object" ? old.version ?? 0 : 0, checkpoint.version ?? 0)
        const pagesVersion = Math.max(typeof old === "object" ? old.pagesVersion ?? 0 : 0, checkpoint.pagesVersion ?? 0)
        const pullsVersion = Math.max(typeof old === "object" ? old.pullsVersion ?? 0 : 0, checkpoint.pullsVersion ?? 0)
        merged[sessionID] = {
          mark: Math.max(mark, checkpoint.mark),
          idle: checkpoint.idle === undefined ? idle : Math.max(idle ?? 0, checkpoint.idle),
          ...(pullsVersion ? { pullsVersion } : {}),
          ...(pagesVersion ? { pagesVersion } : {}),
          ...(version ? {
            version,
            extraMark: Math.max(
              typeof old === "object" && old.version === version ? old.extraMark ?? 0 : 0,
              checkpoint.version === version ? checkpoint.extraMark ?? 0 : 0,
            ),
            extraIdle: Math.max(
              typeof old === "object" && old.version === version ? old.extraIdle ?? 0 : 0,
              checkpoint.version === version ? checkpoint.extraIdle ?? 0 : 0,
            ) || undefined,
          } : {}),
        }
      }
      const pullsUserCheckpoint = mergeUser(previous?.pullsUserCheckpoint, users.pulls)
      return {
        pulls: mergePulls(previous?.pulls ?? [], found),
        pages: mergePages(previous?.pages ?? [], pages),
        ...withLogs(previous?.logs, logs),
        checkpoints: merged,
        userCheckpoint: mergeUser(previous?.userCheckpoint, users.linear),
        ...(pullsUserCheckpoint ? { pullsUserCheckpoint } : {}),
        touched,
      }
    })
  }

  async function saveChat(rootID: string, next: (previous: Chat | undefined, touched: number) => Chat) {
    const now = Date.now()
    const current = chatStore.value.byRoot[rootID]
    if (current && now - current.touched < RETOUCH && isDeepStrictEqual(plain(current), plain(next(current, current.touched)))) return
    await chatStore.update((draft) => {
      draft.byRoot[rootID] = next(draft.byRoot[rootID], now)
      for (const [id, entry] of Object.entries(draft.byRoot)) {
        if (now - entry.touched > FORGET) delete draft.byRoot[id]
      }
    })
  }

  function withLogs(previous: readonly string[] | undefined, found: readonly string[]) {
    const logs = [...new Set([...(previous ?? []), ...found])].slice(-LOGS)
    return logs.length > 0 ? { logs } : {}
  }

  function mergeUser(old: Checkpoint | undefined, next: Checkpoint | undefined): Checkpoint | undefined {
    const version = Math.max(old?.version ?? 0, next?.version ?? 0)
    if (!version) return undefined
    const pick = (checkpoint: Checkpoint | undefined, value: (checkpoint: Checkpoint) => number) =>
      checkpoint?.version === version ? value(checkpoint) : 0
    return {
      version,
      mark: Math.max(pick(old, (checkpoint) => checkpoint.mark), pick(next, (checkpoint) => checkpoint.mark)),
      idle: Math.max(pick(old, (checkpoint) => checkpoint.idle ?? 0), pick(next, (checkpoint) => checkpoint.idle ?? 0)) || undefined,
    }
  }

  function scan(rootID: string, caller = abort.signal): Promise<boolean> {
    const signal = AbortSignal.any([abort.signal, caller])
    if (signal.aborted) return Promise.resolve(false)
    const running = scans.get(rootID)
    if (running) {
      queued.set(rootID, signal)
      return running
    }
    const started = Date.now()
    const retrying = pending.delete(rootID)
    const task = scanRoot(rootID, signal)
      .then(() => {
        if (signal.aborted) throw new Error("Scan aborted")
        scanned.set(rootID, started)
        return true
      })
      .catch(() => {
        if (retrying) pending.add(rootID)
        return false
      })
      .finally(() => {
        scans.delete(rootID)
        const next = queued.get(rootID)
        queued.delete(rootID)
        if (next && !next.aborted) void scan(rootID, next)
      })
    scans.set(rootID, task)
    return task
  }

  const github = createRefresher<Pull, { title: string; state: State }>(host, {
    id: "github",
    checked: (pull) => knownStore.value.byKey[pull.key]?.checked ?? 0,
    changed: (pull) => pull.created,
    phase: (pull) => {
      const state = knownStore.value.byKey[pull.key]?.state
      return state === "merged" ? "merged" : state === "closed" ? "terminal" : "active"
    },
    partition: (pull) => pull.host,
    background: () => Object.entries(chatStore.value.byRoot).map(([rootID, chat]) => ({
      viewed: extra.viewed?.at(rootID) ?? 0,
      references: chat.pulls.filter((pull) => !hidden.contains(rootID, [pull.key])),
    })),
    load: async (pulls, signal, sent) => {
      const result = await fetchStatuses(pulls, signal, sent)
      return { values: result.statuses, problem: result.problem, failed: result.failed, reset: result.reset }
    },
    save: async (pulls, statuses, checked) => {
      const tracked = new Set(Object.values(chatStore.value.byRoot).flatMap((chat) => chat.pulls.map((pull) => pull.key)))
      const moved = new Set<string>()
      const changed = new Set<string>()
      await knownStore.update((draft) => {
        for (const key of Object.keys(draft.byKey)) {
          if (!tracked.has(key)) delete draft.byKey[key]
        }
        for (const pull of pulls) {
          const status = statuses.get(pull.key)
          const previous = draft.byKey[pull.key]
          if ((previous?.checked ?? 0) > checked) continue
          if (status && previous && previous.state !== "unknown" && previous.state !== status.state) moved.add(pull.key)
          if (status && (previous?.state !== status.state || previous.title !== status.title)) changed.add(pull.key)
          draft.byKey[pull.key] = status
            ? { ...status, checked }
            : { title: previous?.title ?? "", state: previous?.state ?? "unknown", checked }
        }
      })
      if (moved.size === 0 || !extension?.dirty) return changed
      const now = Date.now()
      for (const [rootID, chat] of Object.entries(chatStore.value.byRoot))
        if (chat.pulls.some((pull) => moved.has(pull.key)))
          await extension.dirty(rootID, LINEAR_AFTER_PULL.map((delay) => now + delay)).catch(() => undefined)
      return changed
    },
  }, { ceiling, stats: extra.stats })

  function refresh(pulls: readonly Pull[], signal = abort.signal, options?: RefreshOptions) {
    return github.refresh(pulls, AbortSignal.any([abort.signal, signal]), options)
  }

  async function changePulls(sessionID: string, command: string, at: number) {
    const found = pullChanges(command)
    if (found.length === 0) return
    const rootID = await rootOf(sessionID)
    const keys = (chatStore.value.byRoot[rootID]?.pulls ?? [])
      .filter((pull) => found.some((target) => targets(pull, target, knownStore.value.byKey[pull.key]?.state === "merged")))
      .map((pull) => pull.key)
    await github.invalidate(keys, (ASYNC.test(command) ? BURST : [0]).map((delay) => at + delay))
  }

  function absent(pull: Pull) {
    const known = knownStore.value.byKey[pull.key]
    return known !== undefined && known.state === "unknown" && known.title === "" && known.checked > pull.created + ABSENT_AFTER
  }

  async function record(sessionID: string, found: Pull[]) {
    const rootID = await rootOf(sessionID)
    await saveChat(rootID, (previous, touched) => ({ ...previous, pulls: mergePulls(previous?.pulls ?? [], found), touched }))
  }

  async function recordPages(sessionID: string, found: Page[], logs: readonly string[] = []) {
    const session = await sessionOf(sessionID)
    if (session.parentID) return
    await saveChat(sessionID, (previous, touched) => ({
      ...previous, pulls: previous?.pulls ?? [], pages: mergePages(previous?.pages ?? [], found), ...withLogs(previous?.logs, logs), touched,
    }))
  }

  async function recordTool(sessionID: string, call: ToolCall) {
    if (!pageEvidence(call.name, call.input, call.output)) return
    const session = await sessionOf(sessionID)
    if (session.parentID) return
    const directory = session.location?.directory
    const logs = serverLogs(call.name, call.input, call.output, directory)
    const known = new Set([...chatStore.value.byRoot[sessionID]?.logs ?? [], ...logs])
    const banners = bannersIn(call.name, call.input, call.output, call.created, known, directory)
    if (logs.length > 0 || banners.length > 0) await recordPages(sessionID, banners, logs)
  }

  function check(origins: readonly string[], signal = abort.signal) {
    if (probing || signal.aborted || abort.signal.aborted) return probing ?? Promise.resolve()
    const active = new Set(origins)
    for (const origin of probed.keys()) if (!active.has(origin)) probed.delete(origin)
    const gone = Object.keys(liveness.value).filter((origin) => !active.has(origin))
    if (gone.length > 0) liveness.update((draft) => { for (const origin of gone) delete draft[origin] })
    const now = Date.now()
    const stale = [...new Set(origins)].filter((origin) => now - (probed.get(origin) ?? 0) >= PROBE_TTL)
    if (stale.length === 0) return Promise.resolve()
    const run = async () => {
      for (let start = 0; start < stale.length && !signal.aborted && !abort.signal.aborted; start += 4) {
        await Promise.all(
          stale.slice(start, start + 4).map(async (origin) => {
            const started = Date.now()
            const result = await probe(origin, AbortSignal.any([abort.signal, signal]))
            if (abort.signal.aborted || signal.aborted) return
            probed.set(origin, started)
            if (result !== "unknown") liveness.update((draft) => { draft[origin] = result })
          }),
        )
      }
    }
    probing = run().finally(() => { probing = undefined })
    return probing
  }

  function probeDue(origins: readonly string[]) {
    return Math.min(Number.POSITIVE_INFINITY, ...origins.map((origin) => (probed.get(origin) ?? 0) + PROBE_TTL))
  }

  const shells = new Map<string, string>()
  const creating = new Map<string, { name: string; input: Record<string, unknown>; command?: string; created: number }>()
  const oldest = (keys: Iterable<string>) => {
    for (const key of keys) return key
    return ""
  }
  const stops = [
    host.on("session.tool.input.started", (event) => {
      if (event.data.name !== "shell" && event.data.name !== "read") return
      shells.set(event.data.id, event.data.name)
      if (shells.size > RECENT) shells.delete(oldest(shells.keys()))
    }),
    host.on("session.tool.called", (event) => {
      const name = shells.get(event.data.id)
      if (!name || !shells.delete(event.data.id)) return
      const input = event.data.input
      const command = name === "shell" && typeof input.command === "string" ? input.command : undefined
      if (name === "shell" && command === undefined) return
      creating.set(event.data.id, { name, input, command, created: event.created })
      if (creating.size > RECENT) creating.delete(oldest(creating.keys()))
    }),
    host.on("session.tool.success", (event) => {
      const call = creating.get(event.data.id)
      if (!call) return
      creating.delete(event.data.id)
      const at = Date.now()
      const sessionID = event.data.sessionID
      const output = outputText(event.data.content)
      const exit = event.data.metadata?.exit
      void recordTool(sessionID, { name: call.name, input: call.input, output, created: call.created }).catch(() => retry(sessionID))
      const command = call.command
      if (command === undefined) return
      void sessionOf(sessionID).then((session) => {
        const found = pullsFromTool(command, output, exit, call.created, placeOf(session, call.input.workdir))
        if (found.length > 0) return record(sessionID, found)
      }).catch(() => retry(sessionID))
      void changePulls(sessionID, command, at).catch(() => undefined)
      const extra = extension?.tool(command, output, exit, call.created) ?? []
      if (extension && extra.length > 0)
        void rootOf(sessionID).then(async (rootID) => {
          await extension.save(rootID, extra).catch((error: unknown) => {
            pending.add(rootID)
            throw error
          })
          await extension.dirty?.(rootID, [at], extra)
        }).catch(() => retry(sessionID))
    }),
    host.on("session.tool.failed", (event) => {
      const call = creating.get(event.data.id)
      creating.delete(event.data.id)
      const command = call?.command
      if (call === undefined || command === undefined || !launched(event.data.metadata)) return
      const sessionID = event.data.sessionID
      void sessionOf(sessionID).then((session) => {
        const found = pullsWorked(command, call.created, placeOf(session, call.input.workdir))
        if (found.length > 0) return record(sessionID, found)
      }).catch(() => retry(sessionID))
      void changePulls(sessionID, command, Date.now()).catch(() => undefined)
    }),
    host.on("session.text.ended", (event) => {
      const found = pagesIn(event.data.text, event.created)
      if (found.length > 0) void recordPages(event.data.sessionID, found).catch(() => retry(event.data.sessionID))
    }),
    host.on("session.inbox.enqueued", (event) => {
      if (event.data.item.type !== "user") return
      const found = extension?.user(event.data.item.payload.text, event.created) ?? []
      const requested = pullsInUser(event.data.item.payload.text, event.created)
      if (found.length === 0 && requested.length === 0) return
      void sessionOf(event.data.sessionID).then(async (session) => {
        if (session.parentID) return
        if (requested.length > 0) await record(session.id, requested)
        if (extension && found.length > 0) await extension.save(session.id, found)
      }).catch(() => retry(event.data.sessionID))
    }),
  ]

  return {
    pulls: (rootID: string) => (chatStore.value.byRoot[rootID]?.pulls ?? []).filter((pull) => !hidden.contains(rootID, [pull.key]) && !absent(pull)),
    pages: (rootID: string) => (chatStore.value.byRoot[rootID]?.pages ?? []).filter((page) => !hidden.contains(rootID, [page.url, ...(page.aliases ?? [])])),
    hasHidden: hidden.hasHidden,
    dismiss: hidden.dismiss,
    restore: hidden.restore,
    liveness: (origin: string): Liveness | undefined => liveness.value[origin],
    rootOf,
    check,
    probeDue,
    status: (key: string) => knownStore.value.byKey[key],
    problem: github.problem,
    scan,
    refresh,
    due: github.due,
    waiting: github.waiting,
    subscribe: github.subscribe,
    pending: (rootID: string) => pending.has(rootID) || unresolved > (scanned.get(rootID) ?? 0),
    dispose() {
      abort.abort()
      stops.forEach((stop) => stop())
    },
  }
}

export type Tracker = ReturnType<typeof createTracker>

function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value))
}
