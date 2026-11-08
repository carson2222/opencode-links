/** @jsxImportSource solid-js */
import type { Context, SessionRef } from "@opencode/plugin/gui"
import { createSignal, Show } from "solid-js"
import type { LinksData } from "./data.ts"
import { LinksList } from "./list.tsx"
import type { Colors } from "./look.ts"

export function createLinksDialog(ctx: Context, data: LinksData, colors: Colors) {
  return (session: SessionRef, expand = false) =>
    ctx.dialogs.open(() => {
      const [expanded, setExpanded] = createSignal(expand)
      data.watch({ session: () => session, active: () => true })
      const view = () => data.view(session.id)
      return (
        <ctx.ui.Dialog
          title="Links"
          footer={
            <Show when={view()?.hidden}>
              <ctx.ui.Button variant="ghost" onClick={() => data.restore(session.id)}>
                Restore hidden links
              </ctx.ui.Button>
            </Show>
          }
        >
          <Show when={view()}>
            {(current) => (
              <LinksList
                ui={ctx.ui}
                data={data}
                sessionID={session.id}
                view={current()}
                colors={colors}
                mode={ctx.appearance.mode()}
                expanded={expanded()}
                onExpand={setExpanded}
              />
            )}
          </Show>
        </ctx.ui.Dialog>
      )
    })
}

export type LinksDialog = ReturnType<typeof createLinksDialog>
