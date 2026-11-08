import { createKeyed, type Context, type SessionRef } from "@opencode/plugin/gui"
import { createMemo, createSignal, onCleanup } from "solid-js"
import { Links, type RowKind, type View, type Watched } from "./contract.ts"

type Surface = {
  readonly session: () => SessionRef | undefined
  readonly active: () => boolean
}

export function createLinksData(ctx: Context) {
  const main = ctx.main(Links)
  const live = ctx.use(Links)
  const [surfaces, setSurfaces] = createSignal<readonly Surface[]>([])

  const watched = createMemo(() => {
    const byID = new Map<string, Watched>()
    const add = (session: SessionRef | undefined, active: boolean) => {
      if (!session?.server.builtin) return
      byID.set(session.id, { sessionID: session.id, active: active || (byID.get(session.id)?.active ?? false) })
    }
    add(ctx.sessions.current(), false)
    for (const surface of surfaces()) add(surface.session(), surface.active())
    return [...byID.values()].sort((a, b) => a.sessionID.localeCompare(b.sessionID))
  })

  createKeyed(
    () => {
      const provider = live()
      return provider.status === "active" ? JSON.stringify([provider.generation, watched()]) : undefined
    },
    () => void main.watch({ sessions: watched() }).catch(() => undefined),
  )

  const report = (title: string) => () => void ctx.toast.show({ title, variant: "error" })

  return {
    view: (sessionID: string | undefined): View | undefined =>
      sessionID === undefined ? undefined : main.state()?.views[sessionID],
    current: () => {
      const session = ctx.sessions.current()
      return session?.server.builtin ? session : undefined
    },
    watch(surface: Surface) {
      setSurfaces((list) => [...list, surface])
      onCleanup(() => setSurfaces((list) => list.filter((item) => item !== surface)))
    },
    open: (url: string) => ctx.system.openExternal(url),
    dismiss: (sessionID: string, kind: RowKind, key: string) =>
      void main.dismiss({ sessionID, kind, key }).catch(report("Couldn't hide link")),
    restore: (sessionID: string) => void main.restore({ sessionID }).catch(report("Couldn't restore hidden links")),
    link: (sessionID: string, value: string) => main.link({ sessionID, value }),
  }
}

export type LinksData = ReturnType<typeof createLinksData>
