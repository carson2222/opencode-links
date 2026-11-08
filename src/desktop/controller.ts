import type { Links } from "../links.ts"
import { createWatch, type Watch } from "../watch.ts"
import type { RowKind, View, Watched } from "./contract.ts"
import { viewOf } from "./view.ts"

export type Window = {
  isFocused(): boolean
  on(event: "focus", listener: () => void): unknown
  on(event: "blur", listener: () => void): unknown
  off(event: "focus", listener: () => void): unknown
  off(event: "blur", listener: () => void): unknown
}

export type Windows = { get(id: number): Window | undefined }

type Entry = { sessions: readonly Watched[]; focused: boolean; stop: () => void }
type Active = { watch: Watch; focused: boolean; rows: string; surfaces: number }
type Lookup = { task: Promise<string | undefined>; stale: boolean }

const PUSH = 50

export function createController(input: { links: Links; windows: Windows; push: (window?: number) => void }) {
  const { links } = input
  const entries = new Map<number, Entry>()
  const roots = new Map<string, string>()
  const resolving = new Map<string, Lookup>()
  const active = new Map<string, Active>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  const watchers = (rootID: string) => [...entries.values()].flatMap((entry) =>
    entry.sessions.filter((session) => session.active && roots.get(session.sessionID) === rootID).map((session) => ({ entry, session })))
  const focused = (rootID: string) => watchers(rootID).some(({ entry }) => entry.focused)

  function reconcile() {
    if (disposed) return
    const wanted = new Set([...entries.values()].flatMap((entry) =>
      entry.sessions.flatMap((session) => {
        const rootID = session.active ? roots.get(session.sessionID) : undefined
        return rootID === undefined ? [] : [rootID]
      })))
    for (const [rootID, current] of active) {
      if (wanted.has(rootID)) continue
      current.watch.dispose()
      active.delete(rootID)
    }
    for (const rootID of wanted) {
      const current = active.get(rootID)
      if (!current) {
        const rows = links.rowsKey(rootID)
        const watch = createWatch(links, { root: () => rootID, focused: () => focused(rootID) })
        active.set(rootID, { watch, focused: focused(rootID), rows, surfaces: watchers(rootID).length })
        continue
      }
      const now = focused(rootID)
      const surfaces = watchers(rootID).length
      const opened = surfaces > current.surfaces
      current.surfaces = surfaces
      if (now !== current.focused) {
        current.focused = now
        if (now) current.watch.focus()
        else current.watch.blur()
      } else if (now && opened) current.watch.enter()
    }
    rows()
  }

  function rows() {
    for (const [rootID, current] of active) {
      const key = links.rowsKey(rootID)
      if (key === current.rows) continue
      current.rows = key
      current.watch.update()
    }
  }

  const watched = (sessionID: string) =>
    [...entries.values()].some((entry) => entry.sessions.some((session) => session.sessionID === sessionID))

  function resolve(sessionID: string, reconnected = false) {
    const known = roots.get(sessionID)
    if (known !== undefined) return Promise.resolve(known)
    const running = resolving.get(sessionID)
    if (running) {
      running.stale ||= reconnected
      return running.task
    }
    const lookup: Lookup = { stale: false, task: Promise.resolve(undefined) }
    const attempt = (): Promise<string | undefined> => links.tracker.rootOf(sessionID).then(
      (rootID) => {
        roots.set(sessionID, rootID)
        return rootID
      },
      () => {
        if (!lookup.stale || disposed || !watched(sessionID)) return undefined
        lookup.stale = false
        return attempt()
      },
    )
    lookup.task = attempt().finally(() => resolving.delete(sessionID))
    resolving.set(sessionID, lookup)
    return lookup.task
  }

  async function settle(window: number, reconnected = false) {
    const missing = entries.get(window)?.sessions.filter((session) => !roots.has(session.sessionID)) ?? []
    if (missing.length === 0) return
    await Promise.all(missing.map((session) => resolve(session.sessionID, reconnected)))
    if (disposed || !entries.has(window) || !missing.some((session) => roots.has(session.sessionID))) return
    reconcile()
    input.push(window)
  }

  const stopConnected = links.host.on("server.connected", () => {
    for (const window of entries.keys()) void settle(window, true)
  })

  async function rootOf(sessionID: string) {
    const rootID = await resolve(sessionID)
    if (rootID === undefined) throw new Error("Chat not found")
    return rootID
  }

  function entry(window: number) {
    const existing = entries.get(window)
    if (existing) return existing
    const win = input.windows.get(window)
    const created: Entry = { sessions: [], focused: win?.isFocused() ?? false, stop: () => undefined }
    if (win) {
      const focus = () => {
        created.focused = true
        reconcile()
        void settle(window)
      }
      const blur = () => { created.focused = false; reconcile() }
      win.on("focus", focus)
      win.on("blur", blur)
      created.stop = () => {
        win.off("focus", focus)
        win.off("blur", blur)
      }
    }
    entries.set(window, created)
    return created
  }

  return {
    state(window: number): { views: Record<string, View> } {
      const views: Record<string, View> = {}
      for (const session of entries.get(window)?.sessions ?? []) {
        const rootID = roots.get(session.sessionID)
        if (rootID !== undefined) views[session.sessionID] = viewOf(links, rootID)
      }
      return { views }
    },
    async watch(window: number, sessions: readonly Watched[]) {
      if (disposed) return
      entry(window).sessions = sessions
      reconcile()
      input.push(window)
      await settle(window)
    },
    async dismiss(sessionID: string, kind: RowKind, key: string) {
      const rootID = await rootOf(sessionID)
      if (kind !== "issue") return links.tracker.dismiss(rootID, key)
      const issue = links.allIssues(rootID).find((item) => item.key === key)
      if (issue && links.issues) await links.issues.dismiss(rootID, issue)
    },
    async restore(sessionID: string) {
      await links.tracker.restore(await rootOf(sessionID))
    },
    async link(sessionID: string, value: string) {
      if (!links.issues) throw new Error("Linear is off")
      return links.issues.link(await rootOf(sessionID), value)
    },
    close(window: number) {
      entries.get(window)?.stop()
      entries.delete(window)
      reconcile()
    },
    changed() {
      if (timer !== undefined || disposed) return
      timer = setTimeout(() => {
        timer = undefined
        if (disposed) return
        rows()
        input.push()
      }, PUSH)
    },
    dispose() {
      disposed = true
      clearTimeout(timer)
      stopConnected()
      for (const current of active.values()) current.watch.dispose()
      active.clear()
      for (const current of entries.values()) current.stop()
      entries.clear()
    },
  }
}

export type Controller = ReturnType<typeof createController>
