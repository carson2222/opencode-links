import type { Host } from "./host.ts"

export function createHidden(host: Host) {
  const state = host.store("hidden")
  return {
    contains: (rootID: string, keys: readonly string[]) => keys.some((key) => state.value.byRoot[rootID]?.[key]),
    hasHidden: (rootID: string) => Object.keys(state.value.byRoot[rootID] ?? {}).length > 0,
    dismiss(rootID: string, key: string) {
      return state.update((draft) => {
        draft.byRoot[rootID] ??= {}
        draft.byRoot[rootID][key] = true
      })
    },
    dismissMany(rootID: string, keys: readonly string[]) {
      return state.update((draft) => {
        draft.byRoot[rootID] ??= {}
        for (const key of keys) draft.byRoot[rootID][key] = true
      })
    },
    restore(rootID: string) {
      return state.update((draft) => {
        delete draft.byRoot[rootID]
      })
    },
    reveal(rootID: string, keys: readonly string[]) {
      return state.update((draft) => {
        const entry = draft.byRoot[rootID]
        if (!entry) return
        for (const key of keys) delete entry[key]
        if (Object.keys(entry).length === 0) delete draft.byRoot[rootID]
      })
    },
  }
}

export type Hidden = ReturnType<typeof createHidden>
