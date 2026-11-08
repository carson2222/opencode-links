import type { OpenCodeClient, OpenCodeEvent, SessionInfo } from "@opencode/client"
import type { schemas } from "./schema.ts"

export type StoreKey = keyof typeof schemas
export type Stored<K extends StoreKey> = (typeof schemas)[K]["Type"]

export type Durable<T> = {
  readonly value: T
  update(mutate: (draft: T) => void): Promise<void>
}

export type Memory<T> = {
  readonly value: T
  update(mutate: (draft: T) => void): void
}

export type EventMap = { [Type in OpenCodeEvent["type"]]: Extract<OpenCodeEvent, { type: Type }> }

export type Host = {
  store<K extends StoreKey>(key: K): Durable<Stored<K>>
  memory<T extends object>(initial: T): Memory<T>
  client(): OpenCodeClient
  on<Type extends OpenCodeEvent["type"]>(type: Type, handler: (event: EventMap[Type]) => void): () => void
  session(sessionID: string): Promise<SessionInfo>
}

const initials: { [K in StoreKey]: () => Stored<K> } = {
  chats: () => ({ byRoot: {} }),
  status: () => ({ byKey: {} }),
  linear: () => ({ byRoot: {}, byKey: {}, aliases: {}, organizations: {} }),
  hidden: () => ({ byRoot: {} }),
  "refresh.github": () => ({ claims: {}, failures: {} }),
  "refresh.linear": () => ({ claims: {}, failures: {} }),
  viewed: () => ({ byRoot: {} }),
  stats: () => ({ hours: {} }),
}

export function initial<K extends StoreKey>(key: K): Stored<K> {
  return initials[key]()
}
