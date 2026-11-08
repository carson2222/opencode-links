import type { SessionMessageInfo } from "@opencode/client"

export type Extension<Reference> = {
  version: number
  userVersion?: number
  assistant: (message: SessionMessageInfo) => Reference[]
  user: (text: string, created: number) => Reference[]
  tool: (command: string, output: string, exit: unknown, created: number) => Reference[]
  save: (rootID: string, references: readonly Reference[]) => Promise<void>
  dirty?: (rootID: string, times: readonly number[], references?: readonly Reference[]) => Promise<void>
}
