import { execFile, type ExecFileException } from "node:child_process"
import { userInfo } from "node:os"

export type CliResult = { error: ExecFileException | null; stdout: string; stderr: string }
type Options = { timeout: number; maxBuffer: number; signal?: AbortSignal }
type Env = Record<string, string | undefined>
type Probe = { result: Promise<Env | undefined>; controller: AbortController; waiters: number }

const PROBE_TIMEOUT = 15_000
const PROBE_RETRY = 60_000

let shellEnv: Env | undefined
let probing: Probe | undefined
let probedAt = Number.NEGATIVE_INFINITY

// Desktop copies the login shell's environment into its process only if a 5 s probe at launch succeeds; under boot
// load it times out and leaves launchd's bare PATH, so CLIs installed by Homebrew and the like are not found.
export async function execCli(file: string, args: readonly string[], options: Options): Promise<CliResult> {
  const result = await run(file, args, options)
  if (result.error?.code !== "ENOENT" || options.signal?.aborted) return result
  if (shellEnv) {
    const recovered = await run(file, args, options, shellEnv)
    if (recovered.error?.code !== "ENOENT" || options.signal?.aborted) return recovered
  }
  const env = await loginEnv(options.signal)
  return env && !options.signal?.aborted ? run(file, args, options, env) : result
}

function run(file: string, args: readonly string[], options: Options, env?: Env) {
  return new Promise<CliResult>((resolve) => {
    execFile(file, args, { ...options, ...(env ? { env } : {}) }, (error, stdout, stderr) => {
      resolve({ error, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

function loginEnv(signal: AbortSignal | undefined): Promise<Env | undefined> {
  if (!probing) {
    if (Date.now() - probedAt < PROBE_RETRY) return Promise.resolve(undefined)
    probedAt = Date.now()
    const controller = new AbortController()
    const current: Probe = {
      controller,
      waiters: 0,
      result: probe("-il", controller.signal)
        .then((env) => env ?? (controller.signal.aborted ? undefined : probe("-l", controller.signal)))
        .then((env) => {
          if (probing === current) probing = undefined
          if (controller.signal.aborted) probedAt = Number.NEGATIVE_INFINITY
          else if (env) shellEnv = env
          return env
        }),
    }
    probing = current
  }
  const current = probing
  current.waiters++
  return new Promise((resolve) => {
    let settled = false
    const settle = (env: Env | undefined) => {
      if (settled) return
      settled = true
      signal?.removeEventListener("abort", leave)
      current.waiters--
      resolve(env)
    }
    const leave = () => {
      settle(undefined)
      if (current.waiters > 0) return
      if (probing === current) probing = undefined
      current.controller.abort()
    }
    if (signal?.aborted) return leave()
    signal?.addEventListener("abort", leave, { once: true })
    void current.result.then(settle)
  })
}

function probe(mode: "-il" | "-l", signal: AbortSignal) {
  const shell = process.env.SHELL || loginShell()
  if (!shell || process.platform === "win32" || signal.aborted) return Promise.resolve(undefined)
  return new Promise<Env | undefined>((resolve) => {
    const child = execFile(shell, [mode, "-c", "env -0"], { timeout: PROBE_TIMEOUT, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024, signal }, (error, stdout) => {
      if (error) return resolve(undefined)
      const env: Env = {}
      for (const line of String(stdout).split("\0")) {
        const split = line.indexOf("=")
        if (split > 0) env[line.slice(0, split)] = line.slice(split + 1)
      }
      resolve(env.PATH ? { ...process.env, ...env } : undefined)
    })
    child.stdin?.end()
  })
}

function loginShell() {
  try {
    return userInfo().shell ?? undefined
  }
  catch {
    return undefined
  }
}
