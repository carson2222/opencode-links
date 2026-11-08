import { describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

async function tool(path: string, output: string) {
  await writeFile(path, `#!/bin/sh\necho ${output}\n`)
  await chmod(path, 0o700)
}

async function scenario(shell: string, body: string) {
  const directory = await mkdtemp(`${tmpdir()}/cli-test-`)
  try {
    await mkdir(`${directory}/login-bin`)
    await mkdir(`${directory}/app-bin`)
    await tool(`${directory}/login-bin/tool`, "found")
    await tool(`${directory}/app-bin/local`, "local")
    await writeFile(`${directory}/shell`, `#!/bin/sh\necho "$1" >> "${directory}/probes"\n${shell.replaceAll("$BIN", `${directory}/login-bin`)}\n`)
    await chmod(`${directory}/shell`, 0o700)
    await writeFile(`${directory}/worker.ts`, `import { existsSync } from "node:fs"
import { execCli } from ${JSON.stringify(resolve("src/cli.ts"))}
const PROBES = ${JSON.stringify(`${directory}/probes`)}
const call = async (file, signal) => {
  const { error, stdout } = await execCli(file, [], { timeout: 5_000, maxBuffer: 1024, signal })
  return error ? String(error.code ?? error.name) : stdout.trim()
}
const results = []
${body}
process.stdout.write(JSON.stringify(results))
`)
    const child = Bun.spawn([process.execPath, `${directory}/worker.ts`], {
      env: { PATH: `${directory}/app-bin`, HOME: directory, SHELL: `${directory}/shell` },
      stdout: "pipe", stderr: "pipe",
    })
    const stdout = await new Response(child.stdout).text()
    expect(await child.exited).toBe(0)
    let probes: string[] = []
    try { probes = (await readFile(`${directory}/probes`, "utf8")).trim().split("\n") } catch {}
    return { results: JSON.parse(stdout), probes }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const LOGIN = "printf 'PATH=%s\\000' \"$BIN\""
const repeat = (count: number, file = "tool") => `for (let i = 0; i < ${count}; i++) results.push(await call(${JSON.stringify(file)}))`

describe("CLI lookup through the login shell", () => {
  test("probes once and reuses the login environment", async () => {
    const { results, probes } = await scenario(LOGIN, repeat(3))
    expect(results).toEqual(["found", "found", "found"])
    expect(probes).toEqual(["-il"])
  })

  test("a failed interactive probe falls back to a login probe", async () => {
    const { results, probes } = await scenario(`[ "$1" = -il ] && exit 1\n${LOGIN}`, repeat(1))
    expect(results).toEqual(["found"])
    expect(probes).toEqual(["-il", "-l"])
  })

  test("a failed probe is not retried within a minute", async () => {
    const { results, probes } = await scenario("exit 1", repeat(3))
    expect(results).toEqual(["ENOENT", "ENOENT", "ENOENT"])
    expect(probes).toEqual(["-il", "-l"])
  })

  test("a CLI on the app's own PATH keeps working after another CLI needed the login shell", async () => {
    const { results } = await scenario("printf 'PATH=/nowhere\\000'", `${repeat(1, "local")}\n${repeat(1, "missing")}\n${repeat(1, "local")}`)
    expect(results).toEqual(["local", "ENOENT", "local"])
  })

  test("aborting during a probe settles at once, kills it and lets the next call probe again", async () => {
    const { results, probes } = await scenario(`[ "$1" = -il ] && /bin/sleep 2 && exit 1\n${LOGIN}`, `
const controller = new AbortController()
const pending = call("tool", controller.signal)
while (!existsSync(PROBES)) await Bun.sleep(10)
const aborted = Date.now()
controller.abort()
results.push(await pending, Date.now() - aborted < 1_000)
results.push(await call("tool"))`)
    expect(results).toEqual(["ENOENT", true, "found"])
    expect(probes).toEqual(["-il", "-il", "-l"])
  })
})
