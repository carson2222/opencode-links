import type { Host } from "./host.ts"

const FORGET = 90 * 24 * 60 * 60_000
const THROTTLE = 60_000

export function createViewed(host: Host) {
  const store = host.store("viewed")
  return {
    at: (rootID: string) => store.value.byRoot[rootID] ?? 0,
    async mark(rootID: string) {
      const now = Date.now()
      if (now - (store.value.byRoot[rootID] ?? 0) < THROTTLE) return
      await store.update((draft) => {
        draft.byRoot[rootID] = now
        for (const [id, at] of Object.entries(draft.byRoot)) if (now - at > FORGET) delete draft.byRoot[id]
      })
    },
  }
}

export type Viewed = ReturnType<typeof createViewed>
