import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { homedir } from "node:os"
import { bannersIn, serverLogs } from "../src/pages.ts"
import { pullChanges, pullsFromTool, pullsInUser, type Locate } from "../src/pulls.ts"
import { parseRemote, remoteOf, repoAt } from "../src/remote.ts"
import { pureFilter } from "../src/shell.ts"

const repos: Record<string, { host: string; owner: string; repo: string }> = {
  "/dev/shop-backend": { host: "github.com", owner: "acme", repo: "backend" },
  "/dev/shop-frontend": { host: "github.com", owner: "acme", repo: "frontend" },
}
const locate: Locate = (directory) => repos[directory.replace(/\/[^/]+\/\.\.(?=\/|$)/g, "")]
const keys = (command: string, output = "", exit: unknown = 0, cwd?: string) =>
  pullsFromTool(command, output, exit, 1, { cwd, locate }).map((pull) => pull.key)

describe("PRs this chat worked on or monitored", () => {
  test.each([
    ["gh pr merge 32 -R acme/components --squash --delete-branch", "github.com/acme/components#32"],
    ["gh pr close https://github.com/Acme/Web/pull/7 -c 'superseded'", "github.com/acme/web#7"],
    ["GH_REPO=acme/api gh pr ready 9", "github.com/acme/api#9"],
    ["gh pr comment 640 --repo acme/backend --body-file - <<'EOF'\nreuse the cache\nEOF", "github.com/acme/backend#640"],
    ["gh pr review 5 -R acme/web --approve", "github.com/acme/web#5"],
    ["gh pr checkout 464 -R acme/frontend && git push", "github.com/acme/frontend#464"],
    ["R=acme/backend; gh pr merge 1011 --repo $R --squash", "github.com/acme/backend#1011"],

    ["gh pr view 725 -R acme/backend --json isDraft,mergeable,reviewDecision,statusCheckRollup --jq '.reviewDecision'", "github.com/acme/backend#725"],
    ["gh pr view 134 -R acme/docs --json body -q .body | sed 's/a/b/' | gh pr edit 134 -R acme/docs --body-file -", "github.com/acme/docs#134"],
  ])("%s", (command, key) => expect(keys(command)).toEqual([key]))

  test("piped checks count as issued", () => {
    expect(keys("gh pr checks 733 -R acme/backend 2>&1 | grep -i catalog-read", "")).toEqual(["github.com/acme/backend#733"])
  })

  test("bare numbers use the git remote of the directory each statement runs in", () => {
    const command = "cd /dev/shop-backend && gh pr view 1158 --json state,mergeStateStatus; cd ../shop-frontend && gh pr view 460 --json mergeStateStatus"
    const shown = '{"mergeStateStatus":"CLEAN","state":"OPEN"}\n{"mergeStateStatus":"BLOCKED"}\n'
    expect(keys(command, shown)).toEqual(["github.com/acme/backend#1158", "github.com/acme/frontend#460"])
    expect(keys("gh pr checks 374 2>&1 | head -20", "Some checks are still pending\n", 8, "/dev/shop-frontend")).toEqual(["github.com/acme/frontend#374"])
    expect(keys("gh pr checks 374", "", 0, "/somewhere/else")).toEqual([])
    expect(keys("gh pr checks 374")).toEqual([])
    expect(keys("cd $DIR && gh pr merge 3", "", 0, "/dev/shop-backend")).toEqual([])
  })

  test.each([
    ["gh pr list -R acme/web --state open --json number,statusCheckRollup"],
    ["gh pr view 724 -R acme/web --json title,body,files"],
    ["gh pr view 302 --repo acme/frontend --json url,state,statusCheckRollup,commits > /tmp/snapshot.json"],
    ["for n in 287 298 302; do gh pr checks $n -R acme/frontend; done"],
    ["gh pr checks 1 -R a/b; gh pr checks 2 -R a/b; gh pr checks 3 -R a/b; gh pr checks 4 -R a/b"],
    ["gh pr merge --help"],
    ["gh pr checks -R acme/web"],
    ["echo 'gh pr merge 42 -R acme/web'"],
    ["printf '%s\\n' gh pr merge 42 -R acme/web"],
    ["# gh pr merge 42 -R acme/web"],
    ["cat > /tmp/run.sh <<'EOF'\ngh pr merge 42 -R acme/web\nEOF"],
    ["merge() { gh pr merge 42 -R acme/web; }"],
    ["bash -c 'gh pr merge 42 -R acme/web'"],
    ["if true; then gh pr merge 42 -R acme/web; fi"],
    ["gh search prs --repo acme/web 42"],
  ])("ignores %s", (command) => expect(keys(command)).toEqual([]))

  test("a skipped cd leaves bare numbers unresolved", () => {
    expect(keys("true || cd /dev/shop-frontend; gh pr merge 42", "", 0, "/dev/shop-backend")).toEqual([])
    expect(keys("cd /dev/shop-frontend || exit 1; gh pr merge 42", "", 0, "/dev/shop-backend")).toEqual(["github.com/acme/frontend#42"])
    expect(keys("(true || cd /dev/shop-frontend; gh pr merge 42)", "", 0, "/dev/shop-backend")).toEqual([])
  })

  test("a conditional cd only steers statements that run only after it", () => {
    const at = (command: string) => keys(command, "", 0, "/dev/shop-backend")
    expect(at("if test -d /dev/shop-frontend; then cd /dev/shop-frontend; fi\ngh pr merge 42")).toEqual([])
    expect(at("[ -d /dev/shop-frontend ] && cd /dev/shop-frontend; gh pr merge 42")).toEqual([])
    expect(at("[ -d /dev/shop-frontend ] && cd /dev/shop-frontend && gh pr merge 42")).toEqual(["github.com/acme/frontend#42"])
    expect(at("test -n x && cd /dev/shop-frontend || gh pr merge 42")).toEqual([])
    expect(at("cd /dev/shop-frontend; gh pr merge 42")).toEqual(["github.com/acme/frontend#42"])
    expect(at("test -f x && { cd /dev/shop-frontend; }; gh pr merge 42")).toEqual([])
    expect(at("test -f x && { cd /dev/shop-frontend; } && gh pr merge 42")).toEqual(["github.com/acme/frontend#42"])
    expect(at("{ cd /dev/shop-frontend; }; gh pr merge 42")).toEqual(["github.com/acme/frontend#42"])
  })

  test("monitoring routed to a file by an enclosing group is not monitoring", () => {
    expect(keys("{ gh pr checks 42 -R acme/web; } > snapshot.json")).toEqual([])
    expect(keys("( gh pr view 42 -R acme/web --json reviews ) > /tmp/x.json")).toEqual([])
    expect(keys("{ gh pr checks 42 -R acme/web; } 2>&1")).toEqual(["github.com/acme/web#42"])
  })

  test("an issued PR action counts whether or not it succeeded", () => {
    expect(keys("gh pr merge 42 -R acme/web 2>&1 | tail -n 0; true", "", 0)).toEqual(["github.com/acme/web#42"])
    expect(keys("gh pr merge 32 -R acme/components", "X Pull request acme/components#32 is not mergeable", 1)).toEqual(["github.com/acme/components#32"])
    expect(keys("false && gh pr merge 42 -R acme/web; true")).toEqual(["github.com/acme/web#42"])
    expect(keys("true || gh pr merge 5 -R acme/web")).toEqual(["github.com/acme/web#5"])
    expect(keys("gh pr merge 5 -R acme/web &")).toEqual(["github.com/acme/web#5"])
    expect(keys("gh pr view 999 -R acme/web --json statusCheckRollup; echo done", "GraphQL: Could not resolve to a PullRequest with the number of 999.\ndone")).toEqual(["github.com/acme/web#999"])
    expect(keys("(cd /dev/shop-frontend && gh pr checkout 12); gh pr checks 13", "", 0, "/dev/shop-backend")).toEqual(["github.com/acme/frontend#12", "github.com/acme/backend#13"])
    expect(keys("{ cd /dev/shop-frontend; }; gh pr ready 14", "", 0, "/dev/shop-backend")).toEqual(["github.com/acme/frontend#14"])
  })

  test("specific review reads are monitoring", () => {
    expect(keys("gh pr view 295 --repo acme/frontend --json title,reviews,comments")).toEqual(["github.com/acme/frontend#295"])
    expect(keys("gh pr view 296 --repo acme/frontend --json latestReviews,reviewRequests -q .")).toEqual(["github.com/acme/frontend#296"])
  })

  test("home-relative directories resolve to that repository or to nothing", () => {
    const home: Locate = (directory) => directory === "~/repo-b" ? { host: "github.com", owner: "acme", repo: "b" } : locate(directory)
    const at = (command: string) => pullsFromTool(command, "", 0, 1, { cwd: "/dev/shop-backend", locate: home }).map((pull) => pull.key)
    expect(at("cd ~/repo-b && gh pr merge 42")).toEqual(["github.com/acme/b#42"])
    expect(at("cd $HOME/repo-b && gh pr merge 42")).toEqual(["github.com/acme/b#42"])
    expect(at("cd ~other/repo && gh pr merge 42")).toEqual([])
  })

  test("keeps today's created rule", () => {
    expect(keys("gh pr create --fill", "https://github.com/acme/web/pull/42\n")).toEqual(["github.com/acme/web#42"])
  })
})

describe("creation needs exit 0", () => {
  const url = "https://github.com/acme/frontend/pull/370"
  test.each([
    ["the frontend #370 shape", `git push -q -u origin HEAD 2>&1 | tail -2; gh pr create --repo acme/frontend --title "feat: hero" --body-file - <<< $'body'; gh pr view --repo acme/frontend --json number,url -q '.number,.url'`, `remote: \n${url}\nargument required when using the --repo flag\n`],
    ["an existing PR", "gh pr create --fill; gh pr view --json url -q .url", `a pull request for branch "x" into branch "main" already exists:\n${url}\n${url}\n`],
  ])("rejects %s", (_name, command, text) => {
    expect(keys(command, text, 1)).toEqual([])
  })
})

describe("status invalidation shares the parser", () => {
  test.each([
    ["{ gh pr close 313 --repo $R >/dev/null && gh pr reopen 313 --repo $R; }", [{ number: 313 }, { number: 313 }]],
    ["gh pr view 9 --json body -q .body | gh pr edit 9 --body-file -", [{ number: 9 }]],
    ["gh pr merge --help", []],
  ])("pullChanges(%s)", (command, expected) => expect(pullChanges(command)).toEqual(expected))
})

describe("PRs the user pastes", () => {
  test("reads canonical PR URLs including deep links", () => {
    const text = "why did this build pause?\n\nhttps://github.com/Acme/Backend/pull/867\nand https://github.com/acme/backend/pull/873/checks"
    expect(pullsInUser(text, 5).map((pull) => [pull.key, pull.url])).toEqual([
      ["github.com/acme/backend#867", "https://github.com/acme/backend/pull/867"],
      ["github.com/acme/backend#873", "https://github.com/acme/backend/pull/873"],
    ])
    expect(pullsInUser("see https://github.com/acme/web/pulls and https://github.com/acme/web/issues/4", 0)).toEqual([])
  })
})

describe("replay-safe creation", () => {
  const old = "https://github.com/acme/web/pull/1\n"
  test("old URLs printed by other statements never count as created", () => {
    expect(keys("gh pr create --title x --help; cat /tmp/old-pr.txt", "https://github.com/acme/web/pull/1\n")).toEqual([])
    expect(keys("gh pr create --fill; echo done", "https://github.com/acme/web/pull/3\ndone\n")).toEqual(["github.com/acme/web#3"])
    expect(keys("cat /tmp/notes.md; gh pr create --fill", "notes\nhttps://github.com/acme/web/pull/2\n")).toEqual(["github.com/acme/web#2"])
  })

  test.each([
    ["a create whose exit is hidden", "cat /tmp/old-pr.txt; gh pr create --title ENG-123 2>/dev/null | tail -0", old],
    ["two candidate URLs", "cat /tmp/old-pr.txt; gh pr create --fill", "https://github.com/acme/web/pull/1\nhttps://github.com/acme/web/pull/2\n"],
    ["a create that prints no URL", "cat /tmp/old-pr.txt; gh pr create --fill --web", old],
    ["a dry run", "cat /tmp/old-pr.txt; gh pr create --fill --dry-run", old],
    ["a create that is not decisive", "cat /tmp/old-pr.txt; gh pr create --fill; true", old],
    ["an exit trap", "trap 'exit 0' EXIT; cat /tmp/old-pr.txt; gh pr create --fill", old],
    ["a background printer", "(sleep 1; cat /tmp/old-pr.txt) & gh pr create --fill", old],
    ["a gh override", "gh() { cat /tmp/old-pr.txt; }; gh pr create --fill", old],
    ["a create into another repository", "cat /tmp/old-pr.txt; gh pr create -R acme/api --fill", old],
    ["a truncated output", "cat /tmp/old-pr.txt; gh pr create --fill", "https://github.com/acme/web/pull/1\n\n[showing lines 2-2 of 900; full output saved to /tmp/x]"],
  ])("rejects %s", (_name, command, output) => {
    expect(keys(command, output)).toEqual([])
  })
})

describe("git remotes", () => {
  test.each([
    ["git@github.com:Acme/Web.git", { host: "github.com", owner: "acme", repo: "web" }],
    ["https://github.com/acme/web", { host: "github.com", owner: "acme", repo: "web" }],
    ["ssh://git@git.example.com:22/acme/web.git", { host: "git.example.com", owner: "acme", repo: "web" }],
    ["work-alias:acme/web.git", undefined],
    ["/srv/git/web.git", undefined],
  ])("parseRemote(%s)", (url, expected) => expect(parseRemote(url)).toEqual(expected))

  test("needs one remote or gh's resolved default", () => {
    const origin = '[remote "origin"]\n\turl = git@github.com:alex/web.git\n'
    const upstream = '[remote "upstream"]\n\turl = https://github.com/acme/web.git\n'
    expect(remoteOf(origin)).toEqual({ host: "github.com", owner: "alex", repo: "web" })
    expect(remoteOf(origin + upstream)).toBeUndefined()
    expect(remoteOf(origin + upstream + "\tgh-resolved = base\n")).toEqual({ host: "github.com", owner: "acme", repo: "web" })
  })

  const root = mkdtempSync(join(tmpdir(), "remote-"))
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  test("reads a worktree's common config from a subdirectory", () => {
    mkdirSync(join(root, "main/.git/worktrees/feat"), { recursive: true })
    writeFileSync(join(root, "main/.git/config"), '[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:acme/web.git\n')
    writeFileSync(join(root, "main/.git/worktrees/feat/commondir"), "../..\n")
    mkdirSync(join(root, "feat/src"), { recursive: true })
    writeFileSync(join(root, "feat/.git"), `gitdir: ${join(root, "main/.git/worktrees/feat")}\n`)
    expect(repoAt(join(root, "feat/src"))).toEqual({ host: "github.com", owner: "acme", repo: "web" })
    expect(repoAt(join(root, "nowhere"))).toBeUndefined()
  })

  test("never resolves ~ or relative directories against the process directory", () => {
    mkdirSync(join(root, "repo-a/.git"), { recursive: true })
    writeFileSync(join(root, "repo-a/.git/config"), '[remote "origin"]\n\turl = git@github.com:acme/a.git\n')
    const cwd = process.cwd()
    process.chdir(join(root, "repo-a"))
    try {
      expect(repoAt("~/chat-links-missing-repo-b")).toBeUndefined()
      expect(repoAt("repo-b")).toBeUndefined()
    } finally { process.chdir(cwd) }
  })
})

describe("dev-server banners", () => {
  const started = new Set(["/tmp/dev.log", "/tmp/opencode/dev.log", join(homedir(), ".config/opencode/dev.log")])
  const urls = (tool: string, input: Record<string, unknown>, output: string, logs: ReadonlySet<string> = started) =>
    bannersIn(tool, input, output, 0, logs).map((page) => page.url)
  const shell = (output: string, command = "tail -20 /tmp/dev.log") => urls("shell", { command }, output)

  test("Next behind portless keeps only the public origin", () => {
    const log = [
      "portless", "", "-- Proxy is running", "-- Using port 4052", "", "  -> https://web-2381.shop.localhost", "",
      "Running: PORT=4052 HOST=127.0.0.1 PORTLESS_URL=https://web-2381.shop.localhost next dev", "",
      "▲ Next.js 16.4.1 (Turbopack)", "- Local:         http://localhost:4052", "- Network:       http://127.99.190.1:4052", "✓ Ready in 263ms",
      "", "  https://other.shop.localhost  ->  localhost:4729  (pid 5150)",
    ].join("\n")
    expect(shell(log, "tail -20 /tmp/dev.log; portless list")).toEqual(["https://web-2381.shop.localhost"])
  })

  test("plain framework banners", () => {
    expect(shell("▲ Next.js 16.3.5\n- Local:         http://localhost:4303\n- Network:       http://127.0.0.1:4303\n")).toEqual(["http://localhost:4303"])
    expect(shell("\x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m\n  ➜  Network: use --host")).toEqual(["http://localhost:5173"])
  })

  test("root reads of a server log", () => {
    expect(urls("read", { path: "/tmp/opencode/dev.log" }, "26:   -> https://shop.localhost\n31: - Local:         http://localhost:4447")).toEqual(["https://shop.localhost", "http://localhost:4447"])
    expect(urls("read", { path: "/tmp/README.md" }, "4: Local: https://rebrand.shop.localhost")).toEqual([])
  })

  test.each([
    ["help text", "portless myapp next dev             # -> https://myapp.localhost"],
    ["machine-wide routes", "Active routes:\n\n  https://other.shop.localhost  ->  localhost:4641  (pid 77131)"],
    ["script output", "390 upload-done-toast -> https://web-2341.shop.localhost/kit/lab/toast-done"],
    ["prose", "4: Local: https://x.shop.localhost (portless, pnpm dev pid in temp)"],
    ["remote hosts", "- Local:   http://192.168.0.5:3000"],
  ])("ignores %s", (_name, output) => expect(shell(output)).toEqual([]))

  test("ignores archived transcripts", () => {
    expect(shell("- Local:         http://localhost:4303", "sqlite3 ~/.local/share/opencode/opencode.db 'select data from session_message'")).toEqual([])
    expect(shell("- Local:         http://localhost:4303", "opencode export ses_x | grep Local")).toEqual([])
    expect(shell("- Local:         http://localhost:4303", "cd ~/.config/opencode && tail dev.log")).toEqual(["http://localhost:4303"])
  })

  test("banners need a server this chat started", () => {
    const banner = "- Local:         http://localhost:9999\n"
    expect(shell(banner, "printf 'Local: http://localhost:9999\\n'")).toEqual([])
    expect(shell(banner, "echo 'Local: http://localhost:9999'; pnpm dev")).toEqual([])
    expect(shell(banner, "cat /tmp/archived.txt")).toEqual([])
    expect(shell(banner, "python3 -c \"print('Local: http://localhost:9999')\"")).toEqual([])
    expect(shell(banner, "tail -20 /tmp/dev.log; cat /tmp/archived.txt")).toEqual([])
    expect(urls("read", { path: "/tmp/other.log" }, `1: ${banner}`)).toEqual([])
    expect(shell(banner, "timeout 20 pnpm --filter web dev")).toEqual(["http://localhost:9999"])
    expect(shell(banner, "cd /repo && (pnpm dev > /tmp/x.log 2>&1 &); sleep 5; tail -5 /tmp/x.log", )).toEqual(["http://localhost:9999"])
    expect(shell(banner, "npx vite build && cat dist/log.txt")).toEqual([])
    expect(shell(banner, "tail /tmp/dev.log; curl -s -o /dev/null -w '- Local:         http://localhost:9999' http://localhost:9999")).toEqual([])
    expect(shell(banner, "tail /tmp/dev.log; curl -s -o /dev/null -w '%{http_code}' http://localhost:9999")).toEqual(["http://localhost:9999"])
    expect(shell(banner, "tail /tmp/dev.log; curl -s http://localhost:3000")).toEqual([])
  })

  test("registers the logs a started server writes", () => {
    expect(serverLogs("shell", { command: "cd /repo && PORT=4000 nohup bun run dev > dev.log 2>&1 &" }, "")).toEqual(["/repo/dev.log"])
    expect(serverLogs("shell", { command: "pnpm build > build.log", workdir: "/repo" }, "")).toEqual([])
    const streamed = "Command moved to the background (shell ID: sh_1).\nOutput is streaming to: /oc/shell/sh_1.out\n"
    expect(serverLogs("shell", { command: "portless run --name shop next start", background: true }, streamed)).toEqual(["/oc/shell/sh_1.out"])
    expect(serverLogs("shell", { command: "sleep 60; gh pr checks 1", background: true }, streamed)).toEqual([])
    const logs = new Set(["/oc/shell/sh_1.out", "/repo/dev.log"])
    expect(urls("shell", { command: "cat /oc/shell/sh_1.out | tail -10; portless list" }, "  -> https://shop.localhost\n", logs)).toEqual(["https://shop.localhost"])
    expect(urls("shell", { command: "sed -n '/^ready/,$p' dev.log | tail -5", workdir: "/repo" }, "- Local: http://localhost:4000\n", logs)).toEqual(["http://localhost:4000"])
  })

  test("only servers in an executed position start or register logs", () => {
    const banner = "- Local:         http://localhost:9999\n"
    expect(serverLogs("shell", { command: "true || pnpm dev >/tmp/other-chat.log" }, "")).toEqual([])
    expect(serverLogs("shell", { command: "(true || pnpm dev >/tmp/other-chat.log &)" }, "")).toEqual([])
    expect(serverLogs("shell", { command: "cd /repo && (true; cd web && pnpm dev > dev.log 2>&1 &); tail dev.log" }, "")).toEqual(["/repo/web/dev.log"])
    expect(serverLogs("shell", { command: "test -d /repo && pnpm dev > /tmp/dev.log &" }, "")).toEqual(["/tmp/dev.log"])
    expect(urls("shell", { command: "true || pnpm dev" }, banner, new Set())).toEqual([])
    expect(urls("shell", { command: "true || pnpm dev >/tmp/other-chat.log; tail /tmp/other-chat.log" }, banner, new Set())).toEqual([])
  })

  test("a skipped cd leaves log paths unresolved", () => {
    expect(serverLogs("shell", { command: "true || cd /other; pnpm dev > dev.log 2>&1 &" }, "", "/repo")).toEqual([])
    expect(serverLogs("shell", { command: "cd /other && pnpm dev > dev.log 2>&1 &" }, "", "/repo")).toEqual(["/other/dev.log"])
  })

  test("a conditional cd only steers log paths that run only after it", () => {
    expect(serverLogs("shell", { command: "if [ -d /other ]; then cd /other; fi\npnpm dev > dev.log 2>&1 &" }, "", "/repo")).toEqual([])
    expect(serverLogs("shell", { command: "[ -d /other ] && cd /other; pnpm dev > dev.log 2>&1 &" }, "", "/repo")).toEqual([])
    expect(serverLogs("shell", { command: "[ -d /other ] && cd /other && pnpm dev > dev.log 2>&1 &" }, "", "/repo")).toEqual(["/other/dev.log"])
    expect(serverLogs("shell", { command: "test -f x && { cd /other; }; pnpm dev > dev.log 2>&1 &" }, "", "/repo")).toEqual([])
  })

  test("relative paths resolve against the session directory", () => {
    expect(serverLogs("shell", { command: "pnpm dev > dev.log 2>&1 &" }, "", "/repo")).toEqual(["/repo/dev.log"])
    expect(serverLogs("shell", { command: "pnpm dev > dev.log", workdir: "web" }, "", "/repo")).toEqual(["/repo/web/dev.log"])
    const logs = new Set(["/repo/dev.log"])
    expect(bannersIn("shell", { command: "tail dev.log" }, "- Local: http://localhost:4000\n", 0, logs, "/repo").map((page) => page.url)).toEqual(["http://localhost:4000"])
    expect(bannersIn("read", { path: "dev.log" }, "1: - Local: http://localhost:4000\n", 0, logs, "/repo").map((page) => page.url)).toEqual(["http://localhost:4000"])
  })
})

describe("pipe filters", () => {
  test.each([
    [["tail", "-2"], true],
    [["tail", "-n", "+2"], true],
    [["grep", "-i", "https"], true],
    [["grep", "-e", "https", "-e", "WEB-"], true],
    [["grep", "-ehttps"], true],
    [["grep", "--regexp=https"], true],
    [["jq", "-r", ".url"], true],
    [["tr", "a", "b"], true],
    [["tail", "-n", "2"], true],
    [["grep", "-A", "3", "WEB"], true],
    [["grep", "999"], true],
    [["cut", "-d", " ", "-f1"], true],
    [["sort", "-t", ",", "-k", "2"], true],
    [["jq", "--arg", "a", "b", ".x"], true],
    [["grep", "-ic", "--color=never", "WEB"], true],
    [["rg", "WEB"], false],
    [["grep", "-rh", "https"], false],
    [["grep", "-R", "https"], false],
    [["grep", "--recursive", "https"], false],
    [["grep", "-d", "recurse", "https"], false],
    [["grep", "--directories=recurse", "https"], false],
    [["jq", "-rf", "filter.jq"], false],
    [["tail", "-f"], false],
    [["grep", "999", "old.log"], false],
    [["grep", "-A", "3", "WEB", "old.log"], false],
    [["tail", "-n", "2", "old.log"], false],
    [["sort", "-k", "2", "old.log"], false],
    [["grep", "--", "-x", "old.log"], false],
    [["tail", "-2", "old.log"], false],
    [["grep", "WEB", "old.log"], false],
    [["grep", "-ehttps", "old.log"], false],
    [["grep", "--regexp=https", "old.log"], false],
    [["grep", "-e", "https", "old.log"], false],
    [["grep", "--files-with-matches", "https", "old.log"], false],
    [["jq", "--rawfile", "old", "old.log", "-n", "$old"], false],
    [["cat", "old.log"], false],
    [["tail", undefined], false],
  ])("%p is stdin-only: %p", (stage, expected) => {
    expect(pureFilter(stage)).toBe(expected)
  })
})
