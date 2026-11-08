type Callback = (error: (Error & { code?: number | string }) | null, stdout: string, stderr: string) => void
type Exec = (command: string, args: readonly string[], callback: Callback) => void

const slot = globalThis as typeof globalThis & { simExec?: Exec }

export function execFile(command: string, args: readonly string[], _options: unknown, callback: Callback) {
  if (!slot.simExec) throw new Error("simulation vendor is not installed")
  slot.simExec(command, args, callback)
}
