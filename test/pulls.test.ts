import { describe, expect, test } from "bun:test"
import { cleanTitle, createsPull, fit, mergePulls, pullsIn, scroll } from "../src/pulls.ts"
import { parse, query } from "../src/github.ts"

describe("createsPull", () => {
  test.each([
    "gh pr create --title 'x' --body-file - <<< $'body'",
    "git push -u origin HEAD 2>&1 | tail -2; gh pr create --repo acme/web --base main --fill",
    "cd ../web && git push && gh pr create --draft --fill",
    "GH_HOST=github.example.com gh pr create --fill",
    "/opt/homebrew/bin/gh pr create --fill",
    "snip gh pr create --fill",
    "(gh pr create --fill)",
    "url=$(gh pr create --fill)",
    "url=$(gh pr create)",
    "true || gh pr create; echo done",
    "gh pr create&& echo done",
    'url="$(gh pr create --fill)"; printf "%s\\n" "$url"',
    String.raw`url="\\$(gh pr create --fill)"; printf '%s\n' "$url"`,
    "cat <<'EOF' | gh pr create --body-file -\nbody\nEOF",
    "gh pr create --title t --body-file - <<'EOF'\nfixes gh pr create\nEOF",
  ])("matches %s", (command) => expect(createsPull(command)).toBe(true))

  test.each([
    "gh pr view 12 --json url",
    "gh pr merge 12 --squash",
    "grep -c 'gh pr create' notes.md",
    "echo 'run gh pr create later'",
    "gh pr created",
    "cat <<'EOF'\ngh pr create --fill\nhttps://github.com/acme/web/pull/1\nEOF",
    "cat > notes.md <<EOF\nthen; gh pr create\nEOF",
    "bash -lc 'gh pr create --fill'",
    "echo \"; gh pr create\"",
    String.raw`printf '%s\n' "\$(gh pr create --fill)" "https://github.com/acme/web/pull/42"`,
    String.raw`printf '%s\n' "\\\$(gh pr create --fill)" "https://github.com/acme/web/pull/42"`,
  ])("ignores %s", (command) => expect(createsPull(command)).toBe(false))
})

describe("pullsIn", () => {
  test("reads standalone pull request URLs", () => {
    const output = "remote: Create a pull request:\nremote:   https://github.com/acme/web/pull/new/feat\nhttps://github.com/acme/web/pull/42\n"
    expect(pullsIn(output, 7)).toEqual([
      {
        key: "github.com/acme/web#42",
        url: "https://github.com/acme/web/pull/42",
        host: "github.com",
        owner: "acme",
        repo: "web",
        number: 42,
        created: 7,
      },
    ])
  })

  test("reads several URLs and other hosts", () => {
    const output = "https://github.com/acme/api/pull/1\nhttps://git.example.com/Acme/Api/pull/2\n"
    expect(pullsIn(output, 0).map((pull) => pull.key)).toEqual(["github.com/acme/api#1", "git.example.com/acme/api#2"])
  })

  test("ignores URLs inside prose", () => {
    const output = 'a pull request for branch "feat" already exists:\nsee https://github.com/acme/web/pull/42 for details'
    expect(pullsIn(output, 0)).toEqual([])
  })
})

describe("mergePulls", () => {
  test("keeps the first record and adds new ones", () => {
    const [first] = pullsIn("https://github.com/acme/web/pull/1", 1)
    const [again] = pullsIn("https://github.com/acme/web/pull/1", 2)
    const [second] = pullsIn("https://github.com/acme/web/pull/2", 3)
    if (!first || !again || !second) throw new Error("fixture")
    expect(mergePulls([first], [again, second, second])).toEqual([first, second])
  })
})

describe("titles", () => {
  test("drops conventional commit prefixes", () => {
    expect(cleanTitle("feat(files): show folder size")).toBe("Show folder size")
    expect(cleanTitle("fix!: retry upload")).toBe("Retry upload")
    expect(cleanTitle("Bump compiler")).toBe("Bump compiler")
    expect(cleanTitle("perf(WEB-1, WEB-2): quiet pages")).toBe("Quiet pages")
  })

  test("fits and scrolls to the width", () => {
    expect(fit("Improve agent navigation", 10)).toBe("Improve a…")
    expect(fit("Short", 10)).toBe("Short")
    expect(scroll("abcdef", 4, 0)).toBe("abcd")
    expect(scroll("abcdef", 4, 4)).toBe("ef  ")
    expect(scroll("abc", 4, 2)).toBe("abc")
  })
})

describe("github", () => {
  const pulls = pullsIn("https://github.com/acme/web/pull/1\nhttps://github.com/acme/web/pull/2\nhttps://github.com/acme/api/pull/3", 0)

  test("queries every pull request in one request", () => {
    expect(query(pulls)).toBe(
      'query { p0: repository(owner: "acme", name: "web") { pullRequest(number: 1) { title state isDraft } } p1: repository(owner: "acme", name: "web") { pullRequest(number: 2) { title state isDraft } } p2: repository(owner: "acme", name: "api") { pullRequest(number: 3) { title state isDraft } } }',
    )
  })

  test("maps states and skips missing pull requests", () => {
    const stdout = JSON.stringify({
      data: {
        p0: { pullRequest: { title: "A", state: "OPEN", isDraft: true } },
        p1: { pullRequest: { title: "B", state: "MERGED", isDraft: false } },
        p2: null,
      },
      errors: [{ message: "Could not resolve to a Repository" }],
    })
    expect([...parse(pulls, stdout).statuses]).toEqual([
      ["github.com/acme/web#1", { title: "A", state: "draft" }],
      ["github.com/acme/web#2", { title: "B", state: "merged" }],
    ])
  })
})
