import type { OpenCodeClient, OpenCodeEvent, SessionInfo } from "@opencode/client"
import type { Storage } from "@opencode/plugin/gui/main"
import { initial, type Durable, type EventMap, type Host, type StoreKey, type Stored } from "../host.ts"
import { schemas } from "../schema.ts"

type Type = OpenCodeEvent["type"]
type Streamed = Exclude<Type, "server.connected">

const SESSIONS = 1_000
const RETRY = 1_000

export function mainHost(input: {
  storage: Pick<Storage, "store">
  client: () => OpenCodeClient
  changed: () => void
}) {
  const handlers = new Map<Type, Set<(event: OpenCodeEvent) => void>>()
  const sessions = new Map<string, SessionInfo>()
  const abort = new AbortController()
  let stream: AbortController | undefined
  let streamed = ""

  function open<K extends StoreKey>(key: K): Durable<Stored<K>> {
    const persisted = input.storage.store<(typeof schemas)[K]>(key, { schema: schemas[key], initial: initial(key) })
    return {
      get value() {
        return persisted.value
      },
      async update(mutate) {
        const draft = structuredClone(persisted.value)
        mutate(draft)
        persisted.set(draft)
        input.changed()
      },
    }
  }

  const types = () => [...handlers.keys()].filter((type): type is Streamed => type !== "server.connected")

  async function follow(signal: AbortSignal) {
    while (!signal.aborted) {
      try {
        for await (const event of input.client().event.subscribe({ types: types(), signal }))
          handlers.get(event.type)?.forEach((handler) => handler(event))
      } catch {}
      if (signal.aborted) return
      await new Promise((resolve) => setTimeout(resolve, RETRY))
    }
  }

  function restart() {
    const next = types().sort().join()
    if (abort.signal.aborted || (stream && next === streamed)) return
    stream?.abort()
    streamed = next
    stream = new AbortController()
    void follow(AbortSignal.any([abort.signal, stream.signal]))
  }

  const host: Host = {
    store: open,
    memory(value) {
      return {
        value,
        update(mutate) {
          mutate(value)
          input.changed()
        },
      }
    },
    client: input.client,
    on<T extends Type>(type: T, handler: (event: EventMap[T]) => void) {
      const listener = (event: OpenCodeEvent) => {
        if (is(event, type)) handler(event)
      }
      const set = handlers.get(type) ?? new Set()
      set.add(listener)
      handlers.set(type, set)
      if (stream) restart()
      return () => {
        set.delete(listener)
      }
    },
    async session(sessionID) {
      const cached = sessions.get(sessionID)
      if (cached) return cached
      const session = await input.client().session.get({ sessionID })
      if (sessions.size >= SESSIONS) sessions.delete(sessions.keys().next().value ?? "")
      sessions.set(sessionID, session)
      return session
    },
  }

  return {
    host,
    start: restart,
    dispose() {
      abort.abort()
    },
  }
}

function is<T extends Type>(event: OpenCodeEvent, type: T): event is EventMap[T] {
  return event.type === type
}
