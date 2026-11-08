import type { Plugin } from "@opencode/plugin/gui"
import { createLinks } from "../links.ts"
import { Links } from "./contract.ts"
import { createController } from "./controller.ts"
import { mainHost } from "./host.ts"
import { importTuiCache, tuiDirectories } from "./import.ts"

export const main: Plugin.MainSetup = (ctx) => {
  const imported = importTuiCache(ctx.storage, tuiDirectories(process.env, ctx.app.channel))
  if (imported.length > 0) ctx.log.write("info", "imported terminal link cache", { stores: imported })

  let changed = () => {}
  const runtime = mainHost({ storage: ctx.storage, client: () => ctx.client, changed: () => changed() })
  const links = createLinks(runtime.host, ctx.options)
  let provider: { changed(window?: number): void } | undefined
  const controller = createController({ links, windows: ctx.windows, push: (window) => provider?.changed(window) })
  changed = controller.changed

  provider = ctx.provide(Links, {
    state: controller.state,
    watch: (input, caller) => controller.watch(caller.window, input.sessions),
    dismiss: (input) => controller.dismiss(input.sessionID, input.kind, input.key),
    restore: (input) => controller.restore(input.sessionID),
    link: (input) => controller.link(input.sessionID, input.value),
  })
  ctx.windows.on("close", (window) => controller.close(window.id))
  runtime.start()

  return () => {
    controller.dispose()
    links.dispose()
    runtime.dispose()
  }
}
