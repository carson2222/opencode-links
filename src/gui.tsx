/** @jsxImportSource solid-js */
import { Command, Plugin, Slot, Style } from "@opencode/plugin/gui"
import { createLinksData } from "./desktop/data.ts"
import { createLinksDialog } from "./desktop/dialog.tsx"
import { HeaderChips, headerCss } from "./desktop/header.tsx"
import { listCss } from "./desktop/list.tsx"
import type { Colors } from "./desktop/look.ts"
import { main } from "./desktop/main.ts"

export default Plugin.define({
  main,
  setup(ctx) {
    const data = createLinksData(ctx)
    const colors: Colors = ctx.options.colors === "theme" ? "theme" : "github"
    const dialog = createLinksDialog(ctx, data, colors)
    const currentView = () => data.view(data.current()?.id)

    ctx.add(Style, listCss + headerCss)

    ctx.add(Slot, {
      at: "session.header",
      order: 5,
      render: (input) => (
        <HeaderChips ctx={ctx} data={data} dialog={dialog} colors={colors} session={input.session} active={input.active} />
      ),
    })

    ctx.add(Command, () => ({
      id: "show",
      title: "Show links",
      group: "Links",
      enabled: currentView() !== undefined,
      run: () => {
        const session = data.current()
        if (session) dialog(session)
      },
    }))

    ctx.add(Command, () => ({
      id: "restore",
      title: "Restore hidden links",
      group: "Links",
      enabled: currentView()?.hidden === true,
      run: () => {
        const session = data.current()
        if (session) data.restore(session.id)
      },
    }))

    ctx.add(Command, () => ({
      id: "link-issue",
      title: "Link issue to this chat",
      group: "Links",
      enabled: currentView()?.linear === true,
      run: async () => {
        const session = data.current()
        const rootID = currentView()?.rootID
        if (!session || rootID === undefined) return
        const value = await ctx.dialogs.prompt({ title: "Link issue to this chat", placeholder: "Linear issue URL or ticket ID" })
        if (value === undefined) return
        if (currentView()?.rootID !== rootID) {
          ctx.toast.show({ title: "Chat changed; link not added", variant: "error" })
          return
        }
        try {
          if (!(await data.link(session.id, value)))
            ctx.toast.show({ title: "Enter a Linear issue URL or a configured ticket ID", variant: "error" })
        } catch {
          ctx.toast.show({ title: "Couldn't link issue", variant: "error" })
        }
      },
    }))
  },
})
