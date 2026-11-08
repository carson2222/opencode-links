import type { Plugin } from "@opencode/plugin/tui"
import { createStore, produce } from "solid-js/store"
import { initial, type Host } from "./host.ts"

export function tuiHost(context: Plugin.Context): Host {
  return {
    store(key) {
      const [value, update] = context.storage.store(key, { initial: initial(key) })
      return {
        get value() {
          return value
        },
        update,
      }
    },
    memory(start) {
      const [value, setValue] = createStore(start)
      return {
        get value() {
          return value
        },
        update: (mutate) => setValue(produce(mutate)),
      }
    },
    client: () => context.client,
    on: (type, handler) => context.data.on(type, handler),
    session: async (sessionID) => context.data.session.get(sessionID) ?? (await context.client.session.get({ sessionID })),
  }
}
