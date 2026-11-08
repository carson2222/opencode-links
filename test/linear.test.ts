import { describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { fetchIssues, issueIn, issuesFromTool, issuesInUser, linearOptions, mergeIssues } from "../src/linear.ts"
import type { Issue, LinearOptions } from "../src/linear.ts"

const OPTIONS: LinearOptions = { workspace: "acme", teams: ["WEB", "OPS"] }
const ORG = "11111111-1111-4111-8111-111111111111"
const ID = "22222222-2222-4222-8222-222222222222"
const TEMP = resolve(process.env.TMPDIR ?? "/tmp", "opencode/linear-test")

function linked(value = "WEB-1971", created = 1, options = OPTIONS, requested = false): Issue {
  const result = issueIn(value, created, options, requested)
  if (!result) throw new Error(`Invalid test issue: ${value}`)
  return result
}

function identifiers(issues: readonly Issue[]) {
  return issues.map((issue) => issue.identifier)
}

function link(identifier: string) {
  return `https://linear.app/acme/issue/${identifier}/title`
}

function updated(identifier = "WEB-1971", workspace = "acme") {
  return `Updating issue ${identifier}\n\n✓ Updated issue ${identifier}: A title\nhttps://linear.app/${workspace}/issue/${identifier}/a-title\n`
}

describe("Linear options and identities", () => {
  test("defaults are URL-driven and do not assume a workspace or team", () => {
    expect(linearOptions(undefined)).toEqual({})
    expect(linearOptions(true)).toEqual({})
    expect(linearOptions(false)).toBe(false)
    expect(issueIn("WEB-1", 1, {})).toBeUndefined()
    expect(issueIn("https://linear.app/other/issue/ABC-1/title", 1, {})).toMatchObject({ workspace: "other", identifier: "ABC-1" })
  })

  test("normalizes validated settings without mutating them", () => {
    const value = { workspace: "AcMe", teams: ["web", "OPS", "WEB"] }
    expect(linearOptions(value)).toEqual(OPTIONS)
    expect(value.teams).toEqual(["web", "OPS", "WEB"])
    expect(linearOptions({ teams: [] })).toEqual({ teams: [] })
  })

  test.each([null, 1, "yes", [], { workspace: "" }, { workspace: "a/b" }, { workspace: "-foo" }, { teams: "WEB" }, { teams: ["WEB-"] }, { teams: [1] }].map((value) => ({ value })))("rejects invalid settings %p", ({ value }) => {
    expect(linearOptions(value)).toBe(false)
  })

  test("normalizes URL identity and preserves canonical paths", () => {
    expect(linked("https://LINEAR.APP/ACME/issue/web-1971/title?x=1#comment-test", 7)).toEqual({
      key: "linear:acme:WEB-1971", workspace: "acme", identifier: "WEB-1971",
      url: "https://linear.app/acme/issue/WEB-1971/title?x=1#comment-test", created: 7, requested: false,
    })
    expect(linked("web-1971").key).toBe("linear:acme:WEB-1971")
    expect(linked("https://linear.app/another/issue/WEB-1971", 1).key).toBe("linear:another:WEB-1971")
  })

  test("bare identifiers require both workspace and an allowed team", () => {
    expect(issueIn("WEB-1", 1, { workspace: "acme" })).toBeUndefined()
    expect(issueIn("WEB-1", 1, { teams: ["WEB"] })).toBeUndefined()
    expect(issueIn("OTHER-1", 1, OPTIONS)).toBeUndefined()
    expect(issueIn("ops-32", 1, OPTIONS, true)?.requested).toBe(true)
  })

  test.each(["WEB-0", "WEB-01", "WEB--1", "WEB-1-more", "WEB-9999999999999999", "http://linear.app/a/issue/WEB-1", "https://linear.app.evil/a/issue/WEB-1", "https://evil@linear.app/a/issue/WEB-1", "https://linear.app:444/a/issue/WEB-1", "https://linear.app/a/issue/WEB-1/title/extra", "https://linear.app/a/issue/WEB%2D1", "https://linear.app/a/issues/WEB-1", "https://linear.app/a/issue/WEB-1/<script>", "work on WEB-1"]) ("rejects invalid identity %s", (value) => {
    expect(issueIn(value, 1, OPTIONS)).toBeUndefined()
  })

  test("rejects invalid provenance timestamps", () => {
    expect(issueIn("WEB-1", Number.NaN, OPTIONS)).toBeUndefined()
  })
})

describe("explicit root-user targets", () => {
  test("accepts explicit targets, standalone URLs and configured identifiers", () => {
    expect(identifiers(issuesInUser("Fix WEB-12 and OPS-3", 8, OPTIONS))).toEqual(["OPS-3", "WEB-12"])
    expect(issuesInUser("https://linear.app/another/issue/ENG-3/title", 8, {})).toEqual([linked("https://linear.app/another/issue/ENG-3/title", 8, {}, true)])
    expect(identifiers(issuesInUser("Work on these issues:\nWEB-1831\nWEB-2002", 8, OPTIONS))).toEqual(["WEB-1831", "WEB-2002"])
  })

  test("labelled targets inside prose notes remain attached to explicit requests", () => {
    expect(identifiers(issuesInUser("Fix the dashboard crash (ticket WEB-5)", 1, OPTIONS))).toEqual(["WEB-5"])
    expect(identifiers(issuesInUser("Fix the dashboard crash (ticket WEB-5) :)", 1, OPTIONS))).toEqual(["WEB-5"])
    expect(identifiers(issuesInUser("Fix the dashboard crash (ticket WEB-5) (see WEB-9", 1, OPTIONS))).toEqual(["WEB-5"])
    expect(identifiers(issuesInUser("Work on the gallery bug (Linear WEB-5)", 1, OPTIONS))).toEqual(["WEB-5"])
    expect(identifiers(issuesInUser("Implement the export (issue: https://linear.app/ws/issue/WEB-5/export)", 1, OPTIONS))).toEqual(["WEB-5"])
    expect(identifiers(issuesInUser("Work on these issues:\n(the dashboard crash, ticket WEB-5)", 1, OPTIONS))).toEqual(["WEB-5"])
    expect(identifiers(issuesInUser("Fix (ticket WEB-5) and (ticket WEB-6)", 1, OPTIONS))).toEqual(["WEB-5", "WEB-6"])
    expect(identifiers(issuesInUser("Fix WEB-1 (similar to (WEB-9))", 1, OPTIONS))).toEqual(["WEB-1"])
    expect(identifiers(issuesInUser("WEB-1 (same as WEB-9) + WEB-2", 1, OPTIONS))).toEqual(["WEB-1", "WEB-2"])
    expect(identifiers(issuesInUser("Fix WEB-1 (see WEB-9", 1, OPTIONS))).toEqual(["WEB-1"])
    expect(issuesInUser("(notes about WEB-9)", 1, OPTIONS)).toEqual([])
  })

  test("URLs work without settings but bare IDs do not", () => {
    expect(issuesInUser("Fix WEB-12", 1, {})).toEqual([])
    expect(identifiers(issuesInUser("Fix https://linear.app/other/issue/ENG-2/title.", 1, {}))).toEqual(["ENG-2"])
  })

  test("known older issue-work template scans arguments only", () => {
    const text = "Work on this Linear ticket.\n\nRead the ticket, its comments and the code it touches.\nExample WEB-1286.\nMerging stays mine.\n\n\n\nhttps://linear.app/acme/issue/WEB-1831/title"
    expect(identifiers(issuesInUser(text, 1, OPTIONS))).toEqual(["WEB-1831"])
  })

  test("known multi-issue template supports all ten explicit arguments", () => {
    const text = "Work on this Linear issue or more at once.\n\nRead the issue, its comments and the code it touches.\nExample WEB-1082.\nFor this sample, group stuff in one pr per repo etc.\n\n\n\nCore: WEB-1912 + WEB-1886 + WEB-1882\nSame-pass cleanup: WEB-1844, WEB-1910, WEB-1913, WEB-1915, WEB-1924, WEB-1925, WEB-1926"
    expect(identifiers(issuesInUser(text, 1, OPTIONS))).toEqual(["WEB-1844", "WEB-1882", "WEB-1886", "WEB-1910", "WEB-1912", "WEB-1913", "WEB-1915", "WEB-1924", "WEB-1925", "WEB-1926"])
  })

  test("legacy template arguments start after its last closing sentence and any blank lines", () => {
    const head = "Work on this Linear issue or more at once.\n\nRead the issue, its comments and the code it touches. Example WEB-1286.\nStatus changes are allowed. Merging stays mine.\n\nFor any additional defects - expand this sample, add another item, or extent future issues."
    const grouped = `${head}\nFor this sample, group stuff in one pr per repo etc.`
    expect(identifiers(issuesInUser(`${grouped}\n\nWEB-1993 + WEB-1949`, 1, OPTIONS))).toEqual(["WEB-1949", "WEB-1993"])
    expect(identifiers(issuesInUser(`${grouped}\n\n WEB-1951\n\nThis is a layout study, present a mockup (see WEB-9 later)`, 1, OPTIONS))).toEqual(["WEB-1951"])
    expect(identifiers(issuesInUser(`${head}\n\n\n\nhttps://linear.app/acme/issue/WEB-1856/title`, 1, OPTIONS))).toEqual(["WEB-1856"])
    const prose = `${grouped}\n\n\n\n- WEB-1852 and its children WEB-1853 (backend) and WEB-1854 (frontend): Acme enabled 10 new document types.\n\nUnrelated: WEB-1900 is similar.`
    expect(identifiers(issuesInUser(prose, 1, OPTIONS))).toEqual(["WEB-1852", "WEB-1853", "WEB-1854"])
    expect(issuesInUser(`${head.slice(0, head.indexOf("\n\nFor any"))}\nMove the issues right away.\nWEB-5 example`, 1, OPTIONS)).toEqual([])
  })

  test("current issue-work wrapper scans only its prompt argument", () => {
    const wrapper = (prompt: string) => `Start work on the Linear issue IDs or links and any extra notes below. This is a sample request; apply its extra constraints.\n\nReview the issues, notes, relevant files and related sample work. Start with a brief status check, then set the issues you take on to In Progress, e.g. WEB-1286.\n\nInclude small adjacent repairs that support the stated result.\n\nCarson's prompt:\n\n${prompt}`
    const question = "could this layout work? wouldn't it affect readers, files we show etc? https://linear.app/acme/issue/WEB-2474/on-featured-folder-display-much-larger-preview-of-a-file-in-the-grid\n\nroughly four folders have very few documents, see WEB-9"
    expect(identifiers(issuesInUser(wrapper(question), 1, OPTIONS))).toEqual(["WEB-2474"])
    expect(issuesInUser(wrapper(question), 1, OPTIONS)[0]).toMatchObject({ requested: true })
    expect(identifiers(issuesInUser(wrapper("WEB-2011 + WEB-1972 + the WEB-1461 small repair only"), 1, OPTIONS))).toEqual(["WEB-1461", "WEB-1972", "WEB-2011"])
    expect(identifiers(issuesInUser(wrapper("\n\nWEB-2177: Make uploads feel clear and bring editors back.\n\nwork on this."), 1, OPTIONS))).toEqual(["WEB-2177"])
    const sleep = "WEB-2178 WEB-2299 I will be away. Finish the draft independently. Rebase after the WEB-2340 PR if document rows conflict."
    expect(identifiers(issuesInUser(wrapper(sleep), 1, OPTIONS))).toEqual(["WEB-2178", "WEB-2299"])
    expect(issuesInUser(wrapper(""), 1, OPTIONS)).toEqual([])
    expect(issuesInUser("Start work on the Linear issue IDs or links and any extra notes below.\n\nSee WEB-1286 for an example", 1, OPTIONS)).toEqual([])
  })

  test("a single ticket that opens a direct instruction is requested", () => {
    expect(identifiers(issuesInUser("while i am away, WEB-2529 is a broad sample issue, i'll leave the approach to you. You'll present the layout when i return. Allow enough time for research and implementation.", 1, OPTIONS))).toEqual(["WEB-2529"])
    expect(identifiers(issuesInUser("WEB-2529, we hid the caption but there are no labels on the gallery. Why did that happen. Could the shared layout be too strict for featured images?", 1, OPTIONS))).toEqual(["WEB-2529"])
    expect(issuesInUser("WEB-2529, we hid the caption but there are no labels on the gallery.", 1, OPTIONS)[0]).toMatchObject({ requested: true })
  })

  test.each([
    "Perhaps this relates to folder grouping. an older approach was https://linear.app/acme/issue/WEB-2362/your-folders-on-every-library-page but i don't know if it covers this.",
    "\"Tell the sample Upload chat (WEB-2627) that saving may now return a size refusal without creating a document.\"\n\nincidentally both sample prs have finished merging",
    "about layout examples. Were they used in chat \"WEB-2602 Gallery preview integration\" .",
    "WEB-2371, WEB-2370, WEB-2375, WEB-2360, WEB-2369 Catalog feature updates\n\ncompare the two sample conversations i opened.",
    "I compared the issue with current main (abcdef12). WEB-1952 is In Progress, with a prepared worktree.",
    "WEB-1952 is already resolved, along with WEB-1953.",
    "Context: WEB-1952, see the mockups.",
  ])("mentions stay unrequested %s", (text) => {
    expect(issuesInUser(text, 1, OPTIONS)).toEqual([])
  })

  test("four newlines alone do not give pasted templates an argument contract", () => {
    expect(issuesInUser("Some template containing example WEB-1286\n\n\n\nContext: WEB-1082", 1, OPTIONS)).toEqual([])
    expect(issuesInUser("Work on this Linear ticket.\n\nRead the ticket, its comments and the code it touches.\n\n\n\nWEB-1", 1, OPTIONS)).toEqual([])
    expect(issuesInUser("Work on this Linear ticket.\nWEB-1286", 1, OPTIONS)).toEqual([])
  })

  test("excludes quoted examples, code, pasted logs and XML instruction blocks", () => {
    const text = "Fix WEB-1971.\n\n> Work on WEB-1286\n```sh\nlinear issue update WEB-1082\n```\n    ✓ Updated issue WEB-1831\n$ linear issue view WEB-1832\n`WEB-1833`\n\"Fix WEB-1834\"\n‘Fix WEB-1835’\n<skill_content>Work on WEB-1836</skill_content>\n<checkpoint>Fix WEB-1837</checkpoint>\nContext: WEB-1838\nAlready fixed WEB-1839."
    expect(identifiers(issuesInUser(text, 1, OPTIONS))).toEqual(["WEB-1971"])
  })

  test.each(["You are a subagent spawned by another session.\nFix WEB-1286", "Instructions from: AGENTS.md\nFix WEB-1286", "<skill_content>Fix WEB-1286</skill_content>", "# Checkpoint\nFix WEB-1286", "# Conversation summary\nFix WEB-1286", "NEXT ISSUE\nPreviously considered WEB-1286\nContext WEB-1082", "The current branch is alex/web-1286-example", "Title: WEB-1286 was an earlier task"]) ("excludes non-task evidence %s", (text) => {
    expect(issuesInUser(text, 1, OPTIONS)).toEqual([])
  })

  test("deduplicates and marks user targets as requested", () => {
    const issues = issuesInUser("Fix WEB-1 and https://linear.app/acme/issue/WEB-1/title", 9, OPTIONS)
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ requested: true, created: 9 })
  })

  test("unfenced pasted CLI logs do not attach their URLs", () => {
    expect(issuesInUser(updated(), 1, OPTIONS)).toEqual([])
    expect(issuesInUser(`Fix WEB-2002.\n\n${updated()}`, 1, OPTIONS).map((issue) => issue.identifier)).toEqual(["WEB-2002"])
    expect(issuesInUser("# WEB-1971: Preview tiles\n\nhttps://linear.app/acme/issue/WEB-1971/title", 1, OPTIONS)).toEqual([])
  })

  test("requested list keeps targets beside parenthetical notes", () => {
    const request = "WEB-2247 (this may need care and could affect similar layouts across other panels/views etc) + WEB-2234"
    const prompt = `Outline the changes below before editing files.\n\nKeep each sample's changes together.\n\n\n\nCarson's prompt:\n\n${request}`
    expect(identifiers(issuesInUser(prompt, 1, OPTIONS))).toEqual(["WEB-2234", "WEB-2247"])
    expect(identifiers(issuesInUser(request, 1, OPTIONS))).toEqual(["WEB-2234", "WEB-2247"])
    expect(issuesInUser(request, 1, {})).toEqual([])
    expect(issuesInUser(request, 1, { workspace: "acme", teams: ["OPS"] })).toEqual([])
    expect(identifiers(issuesInUser("WEB-1 (tricky (maybe wider) too) + WEB-2", 1, OPTIONS))).toEqual(["WEB-1", "WEB-2"])
    expect(identifiers(issuesInUser("Fix the tabs (WEB-1, WEB-2)", 1, OPTIONS))).toEqual(["WEB-1", "WEB-2"])
  })

  test("identifiers only inside notes are not requested", () => {
    expect(identifiers(issuesInUser("WEB-1 (same as WEB-9) + WEB-2", 1, OPTIONS))).toEqual(["WEB-1", "WEB-2"])
    expect(identifiers(issuesInUser("WEB-1 (same as WEB-9) + WEB-9", 1, OPTIONS))).toEqual(["WEB-1", "WEB-9"])
    expect(identifiers(issuesInUser("Fix WEB-1 (similar to (WEB-9))", 1, OPTIONS))).toEqual(["WEB-1"])
  })

  test.each(["Context: WEB-1 (tricky) + WEB-2", "Previously WEB-1 (tricky) + WEB-2", "WEB-1 (tricky) + WEB-2 later", "WEB-1 (do not work on this) + WEB-2", "WEB-1 (not work) + WEB-2"])("negative wording still excludes noted lists %s", (text) => {
    expect(issuesInUser(text, 1, OPTIONS)).toEqual([])
  })

  test("URL query parentheses stay part of the target", () => {
    const url = "https://linear.app/acme/issue/WEB-1/title?x=(a)"
    expect(issuesInUser(`${url} (tricky) + WEB-2`, 1, OPTIONS).map((issue) => issue.url)).toEqual([url, "https://linear.app/acme/issue/WEB-2"])
    expect(issuesInUser(`Fix (${url}).`, 1, {}).map((issue) => issue.url)).toEqual([url])
    expect(issuesInUser(`Fix ${url}`, 1, {}).map((issue) => issue.url)).toEqual([url])
  })

  test("unbalanced notes stay conservative", () => {
    expect(issuesInUser("WEB-1 (tricky + WEB-2", 1, OPTIONS)).toEqual([])
    expect(issuesInUser("WEB-1) + WEB-2", 1, OPTIONS)).toEqual([])
    expect(identifiers(issuesInUser("Fix WEB-1 (see WEB-9", 1, OPTIONS))).toEqual(["WEB-1"])
  })

  test("serialized conversation checkpoints cannot introduce task associations", () => {
    const checkpoint = "<conversation-checkpoint>\nFix WEB-1286\nhttps://linear.app/acme/issue/WEB-1082/old\n</conversation-checkpoint>"
    expect(issuesInUser(checkpoint, 1, OPTIONS)).toEqual([])
    expect(identifiers(issuesInUser(`${checkpoint}\nFix WEB-1971`, 1, OPTIONS))).toEqual(["WEB-1971"])
  })
})

describe("confirmed shell mutations", () => {
  test("direct create URL-alone and observed progress output establish membership", () => {
    const url = "https://linear.app/acme/issue/WEB-1839/title\n"
    expect(identifiers(issuesFromTool('linear issue create -t "Title"', url, 0, 1, {}))).toEqual(["WEB-1839"])
    expect(identifiers(issuesFromTool('linear issue create -t "Title"', `Creating issue in WEB\n\n${url}`, 0, 1, {}))).toEqual(["WEB-1839"])
    expect(identifiers(issuesFromTool('linear issue create -t "Title"', `✓ Created issue WEB-1839: Title\n${url}`, 0, 1, {}))).toEqual(["WEB-1839"])
  })

  test("adopted WEB-1971 update uses observed target-specific confirmation and URL", () => {
    const command = `linear issue update WEB-1971 -a self -t "Preview cards for folders and Albums" --description-file /dev/stdin <<< $'Description.\\n\\nScope.'`
    expect(issuesFromTool(command, updated(), 0, 5, {})).toEqual([linked("https://linear.app/acme/issue/WEB-1971/a-title", 5, {})])
  })

  test("update-only evidence ignores deferred comment on WEB-1742", () => {
    const command = 'linear issue update WEB-2002 -s "In Progress"; linear issue comment add WEB-1742 --body "Followup"'
    const output = `${updated("WEB-2002")}✓ Comment added to WEB-1742\nhttps://linear.app/acme/issue/WEB-1742/title#comment-1\n`
    expect(identifiers(issuesFromTool(command, output, 0, 1, OPTIONS))).toEqual(["WEB-2002"])
  })

  test("unsupported output producers cannot forge a failed update's confirmation", () => {
    const command = `linear issue update WEB-1971 -s Done; /bin/sh -c 'printf "✓ Updated issue WEB-1971: A title\\nhttps://linear.app/acme/issue/WEB-1971/a-title\\n"'`
    expect(issuesFromTool(command, updated(), 0, 1, OPTIONS)).toEqual([])
    expect(issuesFromTool("linear issue update WEB-1971 -s Done; linear issue view WEB-1971", updated(), 0, 1, OPTIONS)).toEqual([])
  })

  test.each(["\\n", "\\r", "\\x0a", "\\u000a", "\\012", "\\cJ", "\\C-j", "\\C-J", "\n", "\r"])("line-break-bearing arguments cannot forge a URL-only failed create: %s", (newline) => {
    const command = `linear issue create -t X --project $'not-found${newline}https://linear.app/acme/issue/WEB-1971/existing' 2>&1 | tail -1`
    const output = "https://linear.app/acme/issue/WEB-1971/existing\n"
    expect(issuesFromTool(command, output, 0, 1, OPTIONS)).toEqual([])
  })

  test("multiline descriptions supplied on stdin remain supported", () => {
    const command = `linear issue create -t X --description-file /dev/stdin <<< $'Details\\nhttps://linear.app/acme/issue/WEB-1286/example' 2>&1 | tail -1`
    expect(identifiers(issuesFromTool(command, "https://linear.app/acme/issue/WEB-1971/new\n", 0, 1, OPTIONS))).toEqual(["WEB-1971"])
  })

  test("actual mutation URLs carry workspace without hardcoded team filtering", () => {
    expect(issuesFromTool("linear issue update ENG-2 --workspace OTHER -s Done", updated("ENG-2", "other"), 0, 1, OPTIONS)).toEqual([linked("https://linear.app/other/issue/ENG-2/a-title", 1)])
    expect(identifiers(issuesFromTool("linear --workspace=other issue update ENG-2 -s Done", updated("ENG-2", "other"), 0, 1, OPTIONS))).toEqual(["ENG-2"])
    expect(issuesFromTool("linear issue update ENG-2 --workspace wrong -s Done", updated("ENG-2", "other"), 0, 1, OPTIONS)).toEqual([])
  })

  test("direct invocation prefixes and simple foreground sequences are recognized", () => {
    expect(identifiers(issuesFromTool("cd repo && FOO=bar /opt/homebrew/bin/linear issue update WEB-1971 -s Done # nosnip", updated(), 0, 1, {}))).toEqual(["WEB-1971"])
    expect(identifiers(issuesFromTool("snip linear issue update 'WEB-1971' -s Done", updated(), 0, 1, {}))).toEqual(["WEB-1971"])
    expect(identifiers(issuesFromTool("linear issue update WEB-1 -s Done; linear issue update WEB-2 -s Done", updated("WEB-1") + updated("WEB-2"), 0, 1, {}))).toEqual(["WEB-1", "WEB-2"])
  })

  test("heredoc examples never execute or add their targets", () => {
    const command = "linear issue update WEB-1971 --description-file /dev/stdin <<'EOF'\nlinear issue update WEB-1286 -s Done\nlinear issue create -t example\nEOF"
    expect(identifiers(issuesFromTool(command, updated(), 0, 1, {}))).toEqual(["WEB-1971"])
    expect(issuesFromTool("python3 - <<'PY'\nlinear issue update WEB-1971\nPY", updated(), 0, 1, {})).toEqual([])
  })

  test.each(["linear issue view WEB-1971", "linear issue query --json", "linear issue list", "linear issue comment add WEB-1971 --body test", "linear api '{ issue(id: \"WEB-1971\") { url } }'", "linear issue update WEB-1971 --help", "linear issue create --help", "echo 'linear issue update WEB-1971'", "printf '%s' 'linear issue update WEB-1971'", "sh -c 'linear issue update WEB-1971'", "python3 -c 'linear issue update WEB-1971'", "linear issue update WEB-1971 -s Done &", "linear issue update WEB-1971 -s Done | cat", "false || linear issue update WEB-1971 -s Done", "linear issue update $id -s Done", "echo \"$(linear issue update WEB-1971 -s Done)\"", 'echo "\\$(linear issue update WEB-1971 -s Done)"', "linear issue update WEB-1971 -s Done; echo '✓ Updated issue WEB-1971: A title'", "linear issue update WEB-1971 -s Done; /bin/echo url"]) ("rejects unsafe or unsupported command %s", (command) => {
    expect(issuesFromTool(command, updated(), 0, 1, {})).toEqual([])
  })

  test.each([1, undefined, "0", null])("requires numeric successful exit %p", (exit) => {
    expect(issuesFromTool("linear issue update WEB-1971 -s Done", updated(), exit, 1, {})).toEqual([])
  })

  test("enclosing exit zero, wrong target, progress and URL alone do not confirm update", () => {
    const command = "linear issue update WEB-1971 -s Done; true"
    for (const output of ["Error: failed", "Updating issue WEB-1971\nhttps://linear.app/acme/issue/WEB-1971/title", updated("WEB-1286"), "✓ Updated issue WEB-1971: Title\nhttps://linear.app/acme/issue/WEB-1286/title"]) {
      expect(issuesFromTool(command, output, 0, 1, {})).toEqual([])
    }
    expect(issuesFromTool('linear issue create -t "Title"; linear issue view WEB-1286', "https://linear.app/acme/issue/WEB-1286/title", 0, 1, {})).toEqual([])
  })

  test("start needs its final state confirmation and a known workspace", () => {
    const output = "✓ Created and switched to branch 'web-1971-preview-tiles'\n✓ Issue state updated to 'In Progress'\n"
    expect(issuesFromTool("cd repo && linear issue start WEB-1971", output, 0, 4, OPTIONS)).toEqual([linked("WEB-1971", 4)])
    expect(issuesFromTool("linear --workspace other issue start ENG-2 -b eng-2", output, 0, 4, {})).toEqual([linked("https://linear.app/other/issue/ENG-2", 4, {})])
    expect(issuesFromTool("linear issue start WEB-1971", output, 0, 4, {})).toEqual([])
  })

  test.each([
    ["state update failure still exits 0", "linear issue start WEB-1971", "✓ Switched to 'web-1971'\nFailed to update issue state: Error: denied\n"],
    ["confirmation is not final", "linear issue start WEB-1971", "✓ Issue state updated to 'In Progress'\nhttps://linear.app/acme/issue/WEB-1971/title"],
    ["piped", "linear issue start WEB-1971 2>&1 | tail -1", "✓ Issue state updated to 'In Progress'"],
    ["echo", "linear issue start WEB-1971; echo done", "✓ Issue state updated to 'In Progress'\ndone"],
    ["no explicit target", "linear issue start", "✓ Issue state updated to 'In Progress'"],
  ])("start rejects %s", (_, command, output) => {
    expect(issuesFromTool(command, output, 0, 1, OPTIONS)).toEqual([])
  })

  test("a start followed by another action is not confirmed by that action's exit", () => {
    const command = "linear issue start WEB-1971; linear issue update WEB-2 -s Done"
    expect(identifiers(issuesFromTool(command, "✓ Issue state updated to 'In Progress'", 0, 1, OPTIONS))).toEqual(["WEB-2"])
  })
})

describe("updates proven by exit status", () => {
  test("an update whose exit decides the command's exit counts with hidden output", () => {
    expect(issuesFromTool("linear issue update WEB-1971 -s Done >/dev/null", "", 0, 4, OPTIONS)).toEqual([linked("WEB-1971", 4)])
    expect(identifiers(issuesFromTool('cd ~/repo && linear issue update WEB-2261 -s "In Progress" >/dev/null && echo ok', "ok\n", 0, 1, OPTIONS))).toEqual(["WEB-2261"])
    expect(identifiers(issuesFromTool("linear issue update WEB-1971 -s Done 2>/dev/null && linear issue update WEB-1972 -a self >/dev/null && echo ok", "ok\n", 0, 1, OPTIONS))).toEqual(["WEB-1971", "WEB-1972"])
  })

  test("description files written by an earlier statement keep the update", () => {
    const command = "cat >> /tmp/web2259.md <<'EOF'\n* note with linear issue update WEB-1 inside\nEOF\nlinear issue update WEB-2259 --description-file /tmp/web2259.md >/dev/null && echo ok"
    expect(identifiers(issuesFromTool(command, "ok\n", 0, 1, OPTIONS))).toEqual(["WEB-2259"])
  })

  test("relations and comments run alongside an update without counting themselves", () => {
    const command = "linear issue relation add WEB-2209 duplicate WEB-2125 && linear issue update WEB-2209 -s Duplicate"
    expect(identifiers(issuesFromTool(command, `✓ Created relation: WEB-2209 duplicate WEB-2125\n${updated("WEB-2209")}`, 0, 1, OPTIONS))).toEqual(["WEB-2209"])
    expect(issuesFromTool("linear issue comment add WEB-2267 --body-file /dev/stdin <<'EOF' >/dev/null && echo ok\nnote\nEOF", "ok\n", 0, 1, OPTIONS)).toEqual([])
  })

  test("relation siblings keep printed creation proof without adding their endpoints", () => {
    const command = `linear issue create -t "Help center pages still describe the retired editor" --team WEB --description-file /dev/stdin <<< $'Body.' 2>&1 | tail -2; linear issue relation add WEB-2600 related WEB-1112 2>&1 | tail -1; linear issue relation add WEB-2600 related WEB-1159 2>&1 | tail -1`
    const output = "✓ Created issue WEB-2601: Help center pages still describe the retired editor\nhttps://linear.app/acme/issue/WEB-2601/help-center-pages-still-describe-the-retired-editor\n✓ Created relation WEB-2600 related WEB-1112\n✓ Created relation WEB-2600 related WEB-1159\n"
    expect(identifiers(issuesFromTool(command, output, 0, 1, OPTIONS))).toEqual(["WEB-2601"])
    expect(issuesFromTool("linear issue relation add WEB-2600 related WEB-1112", "✓ Created relation WEB-2600 related WEB-1112\n", 0, 1, OPTIONS)).toEqual([])
    const loop = `for i in 2520 2512; do linear issue comment add WEB-$i --body="Folded into WEB-2507." && linear issue relation add WEB-$i duplicate WEB-2507 && linear issue update WEB-$i -s Duplicate; done`
    const shown = ["2520", "2512"].map((n) => `✓ Added comment to issue WEB-${n}\n${link(`WEB-${n}`)}#comment-${n}\n✓ Created relation WEB-${n} duplicate WEB-2507\n✓ Updated issue WEB-${n}: Title\n${link(`WEB-${n}`)}\n`).join("")
    expect(identifiers(issuesFromTool(loop, shown, 0, 1, OPTIONS))).toEqual(["WEB-2512", "WEB-2520"])
  })

  test.each([
    "linear issue relation add --help",
    "linear issue relation list WEB-2600",
    "linear issue relation add $a related WEB-1",
    "linear issue relation add WEB-1 related WEB-2 | tail -2 /tmp/old-create.log",
    "linear issue update WEB-1 -s Done | tail -n 2 /tmp/old-create.log",
    "linear issue relation add WEB-1 related WEB-2 | cat /tmp/old-create.log",
    "linear issue relation add WEB-1 related WEB-2 | grep WEB /tmp/old-create.log",
    "linear issue relation add WEB-1 related WEB-2 | grep -ehttps /tmp/old-create.log",
    "linear issue relation add WEB-1 related WEB-2 | grep 999 /tmp/old-create.log",
    "linear issue relation add WEB-1 related WEB-2 | grep -rh https",
    "linear issue relation add WEB-1 related WEB-2 | grep --regexp=https /tmp/old-create.log",
    "linear issue relation add WEB-1 related WEB-2 | grep -e https /tmp/old-create.log",
    "linear issue relation add WEB-1 related WEB-2 | rg -i -fpatterns.txt /tmp/old-create.log",
    "linear issue relation add WEB-1 related WEB-2 | jq --rawfile old /tmp/old-create.log -n '$old'",
  ])("other relation commands and file-reading pipes still void output proof %s", (sibling) => {
    const command = `linear issue create -t "X" --team WEB 2>&1 | tail -1; ${sibling}`
    expect(issuesFromTool(command, `${link("WEB-2601")}\n`, 0, 1, OPTIONS)).toEqual([])
  })

  test.each([
    ["2.6.0 add", "linear issue comment add WEB-9 --body hi", "✓ Comment added to WEB-9"],
    ["3.1.0 add", "linear issue comment add WEB-9 --body hi", "✓ Added comment to issue WEB-9"],
    ["3.1.0 reply", "linear issue comment add WEB-9 --body hi", "✓ Added reply to issue WEB-9"],
    ["2.6.0 update", "linear issue comment update 33333333-3333-4333-8333-333333333333 --body hi", "✓ Comment updated"],
    ["3.1.0 update", "linear issue comment update 33333333-3333-4333-8333-333333333333 --body hi", "✓ Updated comment 33333333-3333-4333-8333-333333333333"],
  ])("comment headers attribute their own URL (%s) and never add the commented issue", (_, comment, header) => {
    const command = `linear issue create -t "X" --team WEB; ${comment}`
    const output = `${link("WEB-10")}\n${header}\n${link("WEB-9")}#comment-abc\n`
    expect(identifiers(issuesFromTool(command, output, 0, 1, OPTIONS))).toEqual(["WEB-10"])
    expect(issuesFromTool(command, `${link("WEB-10")}\n✓ Added comment to issue WEB-8\n${link("WEB-9")}#comment-abc\n`, 0, 1, OPTIONS)).toEqual([])
    expect(issuesFromTool(comment, `${header}\n${link("WEB-9")}#comment-abc\n`, 0, 1, OPTIONS)).toEqual([])
  })

  test("the update's workspace comes from the command or the configured default", () => {
    expect(issuesFromTool("linear --workspace other issue update ENG-2 -s Done >/dev/null", "", 0, 1, {})).toEqual([linked("https://linear.app/other/issue/ENG-2", 1, {})])
    expect(issuesFromTool("linear issue update WEB-1971 -s Done >/dev/null", "", 0, 1, {})).toEqual([])
  })

  test.each([
    ["a later statement decides the exit", "linear issue update WEB-1971 -s Done >/dev/null; echo ok", "ok\n"],
    ["a later && chain is broken by a semicolon", "linear issue update WEB-1971 -s Done >/dev/null && echo ok; true", "ok\n"],
    ["piped output", "linear issue update WEB-1971 -s Done 2>&1 | tail -1", "✗ Failed to update issue: Issue not found\n"],
    ["a redirected pipeline", "linear issue update WEB-1971 -s Done >/dev/null | tail -1", ""],
    ["an earlier exit", "exit 0; linear issue update WEB-1971 -s Done >/dev/null", ""],
    ["an earlier exec", "exec /usr/bin/true; linear issue update WEB-1971 -s Done >/dev/null", ""],
    ["an exit trap", "trap 'exit 0' ERR; linear issue update WEB-1971 -s Done >/dev/null", ""],
    ["a builtin exit", "builtin exit 0; linear issue update WEB-1971 -s Done", ""],
    ["a sourced script", "source ./env.sh && linear issue update WEB-1971 -s Done >/dev/null", ""],
    ["an assignment-prefixed exit", "X=1 exit 0; linear issue update WEB-1971 -s Done >/dev/null", ""],
    ["no-execution mode", "set -n; linear issue update WEB-1971 -s Done >/dev/null", ""],
    ["a remapped command", "hash -p /usr/bin/true linear; linear issue update WEB-1971 -s Done", ""],
    ["a replaced search path", "PATH=/tmp/fake linear issue update WEB-1971 -s Done >/dev/null", ""],
    ["a startup file", "BASH_ENV=./x.sh linear issue update WEB-1971 -s Done >/dev/null", ""],
    ["start exits 0 when its state change fails", "linear issue start WEB-1971 >/dev/null", ""],
    ["create output hidden", "linear issue create -t X >/dev/null && echo ok", "ok\n"],
    ["help", "linear issue update WEB-1971 --help >/dev/null", ""],
    ["variable target", "linear issue update $id -s Done >/dev/null", ""],
    ["quoted redirect target", 'linear issue update WEB-1971 -s Done > "out file"', ""],
  ])("does not count %s", (_, command, output) => {
    expect(issuesFromTool(command, output, 0, 1, OPTIONS)).toEqual([])
  })

  test("a failing command never counts", () => {
    expect(issuesFromTool("linear issue update WEB-1971 -s Done >/dev/null", "", 1, 1, OPTIONS)).toEqual([])
  })
})

describe("observed create shapes", () => {
  const url = (identifier: string, workspace = "acme") => `https://linear.app/${workspace}/issue/${identifier}/beta-ticket`
  const create = (tail = "1", flags = "--team WEB") => `linear issue create ${flags} -t "Beta: ticket" --description-file /dev/stdin <<< $'Scope.\\n\\nIt\\'s not ; linear issue create -t fake' 2>&1 | tail -${tail}`

  test("cd, here-string and tail -1 or -2 keep the created URL", () => {
    expect(issuesFromTool(`cd /repo && ${create()}`, `${url("WEB-1957")}\n`, 0, 3, OPTIONS)).toEqual([linked(url("WEB-1957"), 3)])
    expect(identifiers(issuesFromTool(`cd /repo && ${create("2")}`, `\n${url("WEB-1957")}\n`, 0, 3, OPTIONS))).toEqual(["WEB-1957"])
    expect(identifiers(issuesFromTool(`${create("n 2")}`, `\n${url("WEB-1957")}\n`, 0, 3, OPTIONS))).toEqual(["WEB-1957"])
  })

  test("three semicolon-separated creates record every URL", () => {
    const command = `cd /repo && ${create()}; ${create()}; ${create("1", "--team OPS")}`
    expect(identifiers(issuesFromTool(command, `${url("WEB-1996")}\n${url("WEB-1997")}\n${url("OPS-4")}\n`, 0, 1, OPTIONS))).toEqual(["OPS-4", "WEB-1996", "WEB-1997"])
  })

  test("silenced attach with a plain echo does not block later creates", () => {
    const command = `linear issue attach WEB-1957 shot.png >/dev/null 2>&1 && echo attached; ${create()}; linear issue create -t "Next" --description-file /dev/stdin <<< 'Body'`
    const output = `attached\n${url("WEB-1998")}\nCreating issue in WEB\n\n${url("WEB-1999")}\n`
    expect(identifiers(issuesFromTool(command, output, 0, 1, OPTIONS))).toEqual(["WEB-1998", "WEB-1999"])
  })

  test.each([
    ["echoed URL with a failed create", `echo https://linear.app/acme/issue/WEB-5/fake; ${create()}`, `https://linear.app/acme/issue/WEB-5/fake\n✗ Failed to create issue: Team not found\n`],
    ["quoted echo after create", `${create()}; echo 'https://linear.app/acme/issue/WEB-5/fake'`, url("WEB-5")],
    ["printf", `${create()}; printf done`, `${url("WEB-5")}\ndone`],
    ["failed create masked by tail", `cd /repo && ${create()}`, "✗ Failed to create issue: Team not found\n"],
    ["failed create masked by tail -2", create("2"), "✗ Failed to create issue: Title is required\n  Use --title\n"],
    ["unsilenced attach", `linear issue attach WEB-1957 shot.png; ${create()}`, url("WEB-5")],
    ["silenced create", `linear issue create -t X >/dev/null 2>&1; echo done`, `${url("WEB-5")}\ndone`],
    ["stdout-only silenced create", `linear issue create -t X >/dev/null`, url("WEB-5")],
    ["more URLs than creates", create(), `${url("WEB-5")}\n${url("WEB-6")}`],
    ["team scope", create("1", "--team OPS"), url("WEB-5")],
    ["workspace scope", create("1", "--team WEB --workspace other"), url("WEB-5")],
    ["out of order team scope", `${create("1", "--team OPS")}; ${create()}`, `${url("WEB-5")}\n${url("OPS-6")}`],
    ["confirmation for another issue", "linear issue create -t X", `✓ Created issue WEB-6: X\n${url("WEB-5")}`],
    ["view in the same command", `${create()}; linear issue view WEB-5`, url("WEB-5")],
    ["second pipe", `${create()} | cat`, url("WEB-5")],
    ["other pipe", "linear issue create -t X 2>&1 | head -1", url("WEB-5")],
    ["follow tail", "linear issue create -t X | tail -f", url("WEB-5")],
    ["file redirect", "linear issue create -t X > out.txt", url("WEB-5")],
    ["stderr to stdout swap", "linear issue create -t X 1>&2", url("WEB-5")],
    ["or chain", "false || linear issue create -t X", url("WEB-5")],
    ["here-string without a word", "linear issue create -t X <<<", url("WEB-5")],
  ])("rejects %s", (_, command, output) => {
    expect(issuesFromTool(command, output, 0, 1, OPTIONS)).toEqual([])
  })

  test("here-string text never becomes a command", () => {
    const command = "linear issue update WEB-1971 --description-file /dev/stdin <<< 'x; linear issue create -t y' 2>&1"
    expect(identifiers(issuesFromTool(command, `${updated()}${url("WEB-5")}\n`, 0, 1, OPTIONS))).toEqual(["WEB-1971"])
  })

  test("an unattributable URL drops creates but keeps confirmed updates", () => {
    const command = `linear issue update WEB-1971 -s Done; ${create("1", "--team OPS")}`
    expect(identifiers(issuesFromTool(command, `${updated()}${url("WEB-5")}\n`, 0, 1, OPTIONS))).toEqual(["WEB-1971"])
  })
})

describe("recorded commands with unrelated statements", () => {
  const url = (identifier: string, slug = "title") => `https://linear.app/acme/issue/${identifier}/${slug}`
  const block = (identifier: string) => `Updating issue ${identifier}\n\n✓ Updated issue ${identifier}: Title\n${url(identifier)}\n`

  test("sleep between two confirmed creates keeps both", () => {
    const create = (title: string) => `linear issue create -t "${title}" -p 2 --project "Shop Backend — Production" -l BACKEND -s Backlog --description-file /dev/stdin <<< $'## Why\\n\\nRoot cause: \`CACHE_READ_STALE\`; see WEB-2309.' 2>&1 | tail -1`
    const command = `${create("Alert when the image worker can't render")}; sleep 2; ${create("CancelUpload in-flight check")}`
    expect(identifiers(issuesFromTool(command, `${url("WEB-2345")}\n${url("WEB-2346")}\n`, 0, 1, OPTIONS))).toEqual(["WEB-2345", "WEB-2346"])
  })

  test("multiline and ANSI-C quoted descriptions keep the create", () => {
    const multiline = `linear issue create -t "Give editable labels a clear hover state" --description $'Text cursors vary across panels.\n\nVerify with keyboard and mouse.' --project "Shop Frontend" --label FRONTEND --state Todo -p medium --yes --no-input`
    expect(identifiers(issuesFromTool(multiline, `Creating issue in WEB\n✓ Created issue WEB-2382: Give editable labels a clear hover state\n${url("WEB-2382")}\n`, 0, 1, OPTIONS))).toEqual(["WEB-2382"])
    const escaped = `linear issue create --no-interactive -t 'Measure native image resizing' --project 'Shop Frontend' -s Backlog -p 4 --description $'Images use \`resizeImage\`.\\n\\nIt\\'s CPU-backed.'`
    expect(identifiers(issuesFromTool(escaped, `Creating issue in WEB\n\n${url("WEB-1865")}\n`, 0, 1, OPTIONS))).toEqual(["WEB-1865"])
  })

  test("literal-ID update loops count only issues with their own confirmation", () => {
    const command = `for i in 1864 1888 1871; do linear issue update WEB-$i -s "In Progress" -a self; done`
    expect(identifiers(issuesFromTool(command, `${block("WEB-1864")}${block("WEB-1871")}✗ Failed to update issue: denied\n`, 0, 1, OPTIONS))).toEqual(["WEB-1864", "WEB-1871"])
    const sequence = `for i in WEB-1852 WEB-1854; do linear issue update $i -s "In Progress" -a self; done; ls; cd shop-backend && git fetch origin -q && git status -sb | head -3`
    expect(identifiers(issuesFromTool(sequence, `${block("WEB-1852")}${block("WEB-1854")}AGENTS.md\n## main...origin/main [behind 8]\n`, 0, 1, OPTIONS))).toEqual(["WEB-1852", "WEB-1854"])
  })

  test("per-ID success echoes prove silenced loop updates", () => {
    const done = `for i in WEB-1993 WEB-1996 WEB-1988; do linear issue update $i -s Done >/dev/null && echo "$i done"; done; cd /repo && git worktree remove ../wt && echo fe-wt-removed`
    expect(identifiers(issuesFromTool(done, "WEB-1993 done\nWEB-1988 done\nfe-wt-removed\n", 0, 1, OPTIONS))).toEqual(["WEB-1988", "WEB-1993"])
    const numbered = `for i in 1847 1871; do linear issue update WEB-$i -s "In Review" >/dev/null && echo ok $i; done`
    expect(identifiers(issuesFromTool(numbered, "ok 1847\nok 1871\n", 0, 1, OPTIONS))).toEqual(["WEB-1847", "WEB-1871"])
  })

  test("silenced updates followed by a printed status or confirmed chained action", () => {
    expect(identifiers(issuesFromTool("linear issue update WEB-2144 -s Done >/dev/null 2>&1; echo linear=$?; git status --short | wc -l", "linear=0\n       0\n", 0, 1, OPTIONS))).toEqual(["WEB-2144"])
    expect(issuesFromTool("linear issue update WEB-2144 -s Done >/dev/null 2>&1; echo linear=$?; git status --short | wc -l", "linear=1\n       0\n", 0, 1, OPTIONS)).toEqual([])
    const chained = `linear issue update WEB-1882 -s "Backlog" >/dev/null && linear issue comment add WEB-1882 --body-file /dev/stdin <<< $'--- AGENT ---\\n\\nDeferred.'\nlinear issue update WEB-1965 --description-file /dev/stdin <<< $'Follow-ups.'`
    const output = `✓ Comment added to WEB-1882\n${url("WEB-1882")}#comment-abc12345\n${block("WEB-1965")}`
    expect(identifiers(issuesFromTool(chained, output, 0, 1, OPTIONS))).toEqual(["WEB-1882", "WEB-1965"])
  })

  test("updates piped through tail count only from the target's URL", () => {
    expect(identifiers(issuesFromTool("linear issue update WEB-2010 -s Done | tail -1; git status --short | head", `${url("WEB-2010")}\n`, 0, 1, OPTIONS))).toEqual(["WEB-2010"])
    expect(identifiers(issuesFromTool("linear issue update WEB-1918 -s Canceled 2>&1 | tail -2", `✓ Updated issue WEB-1918: Title\n${url("WEB-1918")}\n`, 0, 1, OPTIONS))).toEqual(["WEB-1918"])
    expect(issuesFromTool("linear issue update WEB-2010 -s Done | tail -1", "Updating issue WEB-2010\n", 0, 1, OPTIONS)).toEqual([])
    expect(issuesFromTool("linear issue update WEB-2010 -s Done | tail -1", `${url("WEB-2011")}\n`, 0, 1, OPTIONS)).toEqual([])
  })

  test("literal variables, written description files and comments keep created URLs", () => {
    const command = "T=/tmp/opencode\ncat > $T/i-up.md <<'EOF'\nEvery upload was refused.\nEOF\nlinear issue create -t \"Uploads refused\" --description-file $T/i-up.md -p 2 2>&1 | tail -1\nlinear issue create -t \"Download pending\" --description-file $T/i-dl.md -p 2 2>&1 | tail -1\nrm -f $T/i-*.md"
    expect(identifiers(issuesFromTool(command, `${url("WEB-2165")}\n${url("WEB-2166")}\n`, 0, 1, OPTIONS))).toEqual(["WEB-2165", "WEB-2166"])
    const comments = `linear issue comment add WEB-2364 --body-file /dev/stdin <<< $'--- AGENT ---\\n\\nGallery impact.'; linear issue create -t "Unstable checks" -p 3 --description-file /dev/stdin <<< $'Two retries.' 2>&1 | tail -1`
    expect(identifiers(issuesFromTool(comments, `✓ Comment added to WEB-2364\n${url("WEB-2364")}#comment-def12345\n${url("WEB-2365")}\n`, 0, 1, OPTIONS))).toEqual(["WEB-2365"])
    const lookups = `grep -rln "Image grid" src | head; linear issue query --search "strict checks" --json | jq -r '.nodes[] | "\\(.identifier) \\(.title)"'; linear issue create -t "Strict validation" -p 3 2>&1 | tail -1`
    expect(identifiers(issuesFromTool(lookups, `src/image-grid.tsx\nWEB-1952 Editor safeguards\n${url("WEB-2144")}\n`, 0, 1, OPTIONS))).toEqual(["WEB-2144"])
  })

  test.each([
    ["or trap with an echoed URL", "true || linear issue create -t X 2>&1 | tail -1; echo https://linear.app/acme/issue/WEB-5/x", `${url("WEB-5", "x")}\n`],
    ["URL echoed through a literal variable", "U=https://linear.app/acme/issue/WEB-5/x; linear issue create -t X 2>&1 | tail -1; echo $U", `${url("WEB-5", "x")}\n`],
    ["unknown variable echo", "linear issue update WEB-5 -s Done >/dev/null && echo $MSG", "WEB-5 done\n"],
    ["a file replay beside a confirmation", "linear issue update WEB-5 -s Done; cat old.log", block("WEB-5")],
    ["a search that can print log lines", 'linear issue update WEB-5 -s Done; grep -r "issue" logs', block("WEB-5")],
    ["a listing that prints URL lines", "linear issue query --json | jq -r '.nodes[].url'; linear issue create -t X 2>&1 | tail -1", `${url("WEB-5")}\n${url("WEB-6")}\n`],
    ["a bare ID in list output", "linear issue query --json | jq -r '.nodes[].identifier'; linear issue create -t X 2>&1 | tail -1", "WEB-5\n"],
    ["a loop echo without its ID", "for i in WEB-5 WEB-6; do linear issue update $i -s Done >/dev/null && echo ok; done", "ok\nok\n"],
    ["a loop with semicolon-separated echo", "for i in WEB-5 WEB-6; do linear issue update $i -s Done >/dev/null; echo $i; done", "WEB-5\nWEB-6\n"],
    ["a non-literal loop list", "for i in $IDS; do linear issue update $i -s Done; done", block("WEB-5")],
    ["a replaced search path", "PATH=/tmp/shim:$PATH linear issue create -t X", `${url("WEB-5")}\n`],
    ["an exported search path", "export PATH=/tmp/shim; linear issue update WEB-5 -s Done >/dev/null", ""],
    ["a shell function", "linear() { :; }; linear issue update WEB-5 -s Done", block("WEB-5")],
    ["an unknown compound printing output", "if true; then cat x; fi; linear issue update WEB-5 -s Done", block("WEB-5")],
    ["a status echo after an or", "linear issue update WEB-5 -s Done >/dev/null || echo linear=$?", "linear=0\n"],
  ])("rejects %s", (_, command, output) => {
    expect(issuesFromTool(command, output, 0, 1, OPTIONS)).toEqual([])
  })
})

describe("own created PRs and branches", () => {
  const pr = "https://github.com/acme/shop-frontend/pull/512\n"

  test("created PR title and head name their issues, not base or body", () => {
    const titled = `git push -q -u origin alex/web-2356-stable-page-scroll 2>&1 | tail -2; gh pr create --title "fix(WEB-2356): stable page scroll" --body-file - <<< $'Also touches WEB-9.' 2>&1 | tail -1`
    expect(identifiers(issuesFromTool(titled, pr, 0, 1, OPTIONS))).toEqual(["WEB-2356"])
    expect(issuesFromTool(titled, pr, 0, 1, OPTIONS)[0]).toMatchObject({ requested: false })
    const headed = `gh pr create --repo acme/shop-frontend --base alex/web-1839-plain-files --head alex/web-1843-files-unknown --title "Files never show unknown" --body "Builds on WEB-1839"`
    expect(identifiers(issuesFromTool(headed, pr, 0, 1, OPTIONS))).toEqual(["WEB-1843"])
    expect(identifiers(issuesFromTool(`gh pr create -t "Polish" -H octo:alex/web-77-polish`, pr, 0, 1, OPTIONS))).toEqual(["WEB-77"])
  })

  test("current branch counts only when this command switched to it before the PR", () => {
    expect(identifiers(issuesFromTool(`git checkout alex/web-7-existing && gh pr create --title "Polish" --body "x"`, pr, 0, 1, OPTIONS))).toEqual(["WEB-7"])
    expect(issuesFromTool(`git checkout alex/web-7-existing; cd ../other && gh pr create --title "Polish"`, pr, 0, 1, OPTIONS)).toEqual([])
    expect(issuesFromTool(`git push -u origin alex/web-7-existing && gh pr create --title "Polish"`, pr, 0, 1, OPTIONS)).toEqual([])
  })

  test("successful new branch statements name their issues", () => {
    const worktree = "cd shop-backend && git worktree add -q -b alex/web-1860-web-1872-core-evidence ../worktrees/shop-backend-web-1860 origin/main && ln -s ../../shop-backend/.env ../worktrees/shop-backend-web-1860/.env"
    expect(identifiers(issuesFromTool(worktree, "", 0, 1, OPTIONS))).toEqual(["WEB-1860", "WEB-1872"])
    const shown = "git worktree add /repo/worktrees/infra -b alex/web-2011-library origin/main; ls"
    expect(identifiers(issuesFromTool(shown, "Preparing worktree (new branch 'alex/web-2011-library')\nAGENTS.md\n", 0, 1, OPTIONS))).toEqual(["WEB-2011"])
    expect(identifiers(issuesFromTool("git switch --create web-30-fix", "Switched to a new branch 'web-30-fix'\n", 0, 1, OPTIONS))).toEqual(["WEB-30"])
    expect(identifiers(issuesFromTool("git branch backup/web-2125-pre-rebase aabbcc123 && git checkout -q -b tmp-squash 112233abc", "", 0, 1, OPTIONS))).toEqual(["WEB-2125"])
  })

  test.each([
    ["base branch only", `gh pr create --base alex/web-5-base --title "Polish"`, pr],
    ["body text", `gh pr create --title "Polish" --body "Fixes WEB-5"`, pr],
    ["body file", "gh pr create --title Polish --body-file notes-web-5.md", pr],
    ["no PR URL", `gh pr create --title "fix(WEB-5): x" 2>&1 | tail -1`, "pull request create failed: GraphQL: No commits\n"],
    ["or trap", `true || gh pr create --title "fix(WEB-5): x"; echo https://github.com/o/r/pull/1`, "https://github.com/o/r/pull/1\n"],
    ["checkout of an existing branch", "git checkout alex/web-5-existing", "Switched to branch 'alex/web-5-existing'\n"],
    ["switch to an existing branch", "git switch alex/web-5-existing", ""],
    ["unproven branch creation", "git checkout -b alex/web-5-x; ls", "AGENTS.md\n"],
    ["deleted or renamed branch", "git branch -D alex/web-5-x && git branch -m alex/web-6-y", ""],
    ["detached worktree", "git worktree add --detach /tmp/web-5-review abcdef1", ""],
    ["unconfigured team", "git checkout -b alex/abc-12-x", ""],
  ])("does not count %s", (_, command, output) => {
    expect(issuesFromTool(command, output, 0, 1, OPTIONS)).toEqual([])
  })

  test("PR ownership needs the same replay-safe creation proof as PR rows", () => {
    expect(issuesFromTool(`gh pr create --title WEB-123 --help; cat /tmp/old-pr.txt`, pr, 0, 1, OPTIONS)).toEqual([])
    expect(issuesFromTool(`gh pr create --title "fix(WEB-123): x"; cat /tmp/old-pr.txt`, pr, 0, 1, OPTIONS)).toEqual([])
    expect(identifiers(issuesFromTool(`cat notes.md && gh pr create --title "fix(WEB-123): x"`, `notes\n${pr}`, 0, 1, OPTIONS))).toEqual(["WEB-123"])
    expect(issuesFromTool(`cat old-pr.txt; gh pr create --title WEB-123 2>/dev/null | tail -0`, pr, 0, 1, OPTIONS)).toEqual([])
  })

  test("a failing command never counts", () => {
    expect(issuesFromTool(`gh pr create --title "fix(WEB-5): x"`, pr, 1, 1, OPTIONS)).toEqual([])
    expect(issuesFromTool("git checkout -b alex/web-5-x", "", 1, 1, OPTIONS)).toEqual([])
  })
})

describe("merge provenance", () => {
  test("deduplicates without mutation, requested first, newest timestamps and oldest primary URL", () => {
    const original = linked("https://linear.app/acme/issue/WEB-1/original", 1)
    const latest = linked("https://linear.app/acme/issue/WEB-1/latest", 9, OPTIONS, true)
    const middle = linked("https://linear.app/acme/issue/WEB-1/middle", 4)
    const other = linked("WEB-2", 20)
    const olderRequested = linked("WEB-3", 2, OPTIONS, true)
    const existing = Object.freeze([Object.freeze(original), Object.freeze(other)])
    expect(mergeIssues(existing, [latest, middle, olderRequested])).toEqual([{ ...original, requested: true, created: 9 }, olderRequested, other])
    expect(original).toMatchObject({ created: 1, requested: false })
  })

  test("same identifier in different workspaces remains distinct", () => {
    expect(mergeIssues([linked("WEB-1")], [linked("https://linear.app/another/issue/WEB-1")])).toHaveLength(2)
  })

  test("persisted primary provenance survives later history rescans", () => {
    const original = linked("https://linear.app/acme/issue/WEB-1/original", 1)
    const first = mergeIssues([original], [linked("https://linear.app/acme/issue/WEB-1/latest", 9)])
    const second = mergeIssues(first, [linked("https://linear.app/acme/issue/WEB-1/middle", 4, OPTIONS, true)])
    expect(second).toEqual([{ ...original, created: 9, requested: true }])
  })

  test("resolved UUID survives merges without replacing primary provenance", () => {
    const original = linked("https://linear.app/acme/issue/WEB-1/original", 1)
    const resolved = { ...linked("https://linear.app/acme/issue/WEB-1/latest", 9), id: ID }
    const enriched = mergeIssues([original], [resolved])
    expect(enriched).toEqual([{ ...original, id: ID, created: 9 }])
    expect(mergeIssues(enriched, [linked("WEB-1", 12)])).toEqual([{ ...original, id: ID, created: 12 }])
    expect(original).not.toHaveProperty("id")
  })
})

type Reply = { body?: unknown; stdout?: string; stderr?: string; exit?: number; delay?: number; overflow?: boolean }

function node(identifier = "WEB-1971", id = ID, workspace = "acme") {
  return { id, identifier, previousIdentifiers: [], title: "Preview tiles", url: `https://linear.app/${workspace}/issue/${identifier}/preview-tiles`, state: { name: "Custom review", type: "started", color: "#0f783c" } }
}

function envelope(nodes: unknown[] = [node()], workspace = "acme", errors?: unknown[]) {
  const pageInfo: { hasNextPage: boolean; endCursor: string | null } = { hasNextPage: false, endCursor: null }
  return { data: { organization: { id: ORG, urlKey: workspace }, issues: { nodes, pageInfo } }, ...(errors ? { errors } : {}) }
}

async function runCLI(issues: readonly Issue[], replies: Reply[], options: { missing?: boolean; loginShell?: boolean; abort?: number } = {}) {
  await mkdir(TEMP, { recursive: true })
  const directory = await mkdtemp(`${TEMP}/case-`)
  const worker = `${directory}/worker.ts`
  const fixture = `${directory}/cli.ts`
  const callsFile = `${directory}/calls.jsonl`
  const responses = `${directory}/replies.json`
  await writeFile(responses, JSON.stringify(replies))
  await writeFile(fixture, `import { appendFileSync, readFileSync } from "node:fs"
const path = ${JSON.stringify(callsFile)}
let count = 0
try { count = readFileSync(path, "utf8").trim().split("\\n").filter(Boolean).length } catch {}
appendFileSync(path, JSON.stringify(process.argv.slice(2)) + "\\n")
const replies = JSON.parse(readFileSync(${JSON.stringify(responses)}, "utf8"))
const reply = replies[count] ?? {}
if (reply.delay) await Bun.sleep(reply.delay)
if (reply.overflow) process.stdout.write("x".repeat(1100000))
else process.stdout.write(reply.stdout ?? (reply.body === undefined ? "" : JSON.stringify(reply.body)))
if (reply.stderr) process.stderr.write(reply.stderr)
process.exit(reply.exit ?? 0)
`)
  const bin = options.loginShell ? `${directory}/login-bin` : directory
  if (!options.missing) {
    await mkdir(bin, { recursive: true })
    await writeFile(`${bin}/linear`, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)} "$@"\n`)
    await chmod(`${bin}/linear`, 0o700)
  }
  await writeFile(`${directory}/shell`, `#!/bin/sh\necho "$1" >> ${JSON.stringify(`${directory}/probes`)}\nprintf 'PATH=%s\\000' ${JSON.stringify(options.loginShell ? bin : `${directory}/empty`)}\n`)
  await chmod(`${directory}/shell`, 0o700)
  await writeFile(worker, `import { fetchIssues } from ${JSON.stringify(resolve("src/linear.ts"))}
const controller = new AbortController()
${options.abort === undefined ? "" : options.abort === 0 ? "controller.abort()" : `setTimeout(() => controller.abort(), ${options.abort})`}
const result = await fetchIssues(${JSON.stringify(issues)}, controller.signal)
process.stdout.write(JSON.stringify({ issues: [...result.issues], problem: result.problem }))
`)
  const child = Bun.spawn([process.execPath, worker], {
    cwd: directory,
    env: { PATH: directory, HOME: directory, XDG_CONFIG_HOME: directory, LINEAR_IGNORE_ENV_FILE: "1", SHELL: `${directory}/shell` },
    stdout: "pipe", stderr: "pipe",
  })
  try {
    const stdout = await new Response(child.stdout).text()
    const stderr = await new Response(child.stderr).text()
    const exit = await child.exited
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" })
    const value: unknown = JSON.parse(stdout)
    let calls: unknown[] = []
    try { calls = (await readFile(callsFile, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) } catch {}
    let probes: string[] = []
    try { probes = (await readFile(`${directory}/probes`, "utf8")).trim().split("\n").filter(Boolean) } catch {}
    return { value, calls, probes }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function resultIssues(value: unknown): unknown[] {
  if (typeof value !== "object" || value === null || !("issues" in value) || !Array.isArray(value.issues)) throw new Error("Invalid worker result")
  return value.issues
}

describe("bounded read-only metadata transport", () => {
  test("uses exact documented GraphQL variables, archived inclusion, bounded fields and canonical keys", async () => {
    const issue = linked()
    const result = await runCLI([issue], [{ body: envelope() }])
    expect(result.value).toEqual({ issues: [[issue.key, { ...node(), key: `linear:${ORG}:${ID}`, organizationID: ORG, workspace: "acme" }]] })
    expect(result.calls).toHaveLength(1)
    const call = result.calls[0]
    if (!Array.isArray(call) || !call.every((arg) => typeof arg === "string")) throw new Error("Invalid CLI args")
    expect(call[0]).toBe("api")
    expect(call[1]).toContain("includeArchived: true")
    expect(call[1]).toContain("previousIdentifiers")
    expect(call[1]).toContain("organization { id urlKey }")
    expect(call[1]).not.toContain("mutation")
    expect(call[2]).toBe("--variables-json")
    expect(JSON.parse(call[3])).toEqual({ ids: ["WEB-1971"], first: 1 })
    expect(call.slice(4)).toEqual(["--workspace", "acme"])
  })

  test("batches at forty and groups workspace without mixing scopes", async () => {
    const issues = Array.from({ length: 41 }, (_, index) => linked(`WEB-${index + 1}`))
    issues.push(linked("https://linear.app/other/issue/ENG-1"))
    const result = await runCLI(issues, [{ body: envelope([]) }, { body: envelope([]) }, { body: envelope([], "other") }])
    expect(result.calls).toHaveLength(3)
    const variables = result.calls.map((call) => {
      if (!Array.isArray(call) || typeof call[3] !== "string") throw new Error("Invalid args")
      return JSON.parse(call[3])
    })
    expect(variables.map((value) => value.first)).toEqual([40, 1, 1])
    expect(variables[0].ids).toHaveLength(40)
    expect(variables[1].ids).toEqual(["WEB-41"])
    expect(variables[2].ids).toEqual(["ENG-1"])
  })

  test("missing IDs are absent and unrelated results are never retained", async () => {
    const issue = linked("WEB-999999999")
    const result = await runCLI([issue], [{ body: envelope([node()]) }])
    expect(result.value).toEqual({ issues: [] })
  })

  test("moved identifiers resolve old aliases to the canonical UUID", async () => {
    const moved = { ...node("OPS-3"), previousIdentifiers: ["WEB-1971", "WEB-12"] }
    const result = await runCLI([linked(), linked("WEB-12"), linked("OPS-3")], [{ body: envelope([moved]) }])
    expect(resultIssues(result.value)).toHaveLength(3)
    expect(resultIssues(result.value)[0]).toMatchObject(["linear:acme:WEB-1971", { identifier: "OPS-3", key: `linear:${ORG}:${ID}`, previousIdentifiers: ["WEB-1971", "WEB-12"] }])
  })

  test("canonical identities refresh by UUID and remain keyed by the original requested key", async () => {
    const issue = { ...linked(), key: `linear:${ORG}:${ID}` }
    const result = await runCLI([issue], [{ body: envelope([node("OPS-3")]) }])
    expect(resultIssues(result.value)).toHaveLength(1)
    const call = result.calls[0]
    if (!Array.isArray(call) || typeof call[3] !== "string") throw new Error("Invalid args")
    expect(JSON.parse(call[3])).toEqual({ ids: [ID], first: 1 })
  })

  test("resolved UUID maps moved metadata to a provisional key without requiring identifier aliases", async () => {
    const issue = { ...linked(), id: ID.toUpperCase() }
    const result = await runCLI([issue], [{ body: envelope([node("OPS-3")]) }])
    expect(resultIssues(result.value)).toHaveLength(1)
    expect(resultIssues(result.value)[0]).toMatchObject([issue.key, { id: ID, identifier: "OPS-3" }])
    const call = result.calls[0]
    if (!Array.isArray(call) || typeof call[3] !== "string") throw new Error("Invalid args")
    expect(JSON.parse(call[3])).toEqual({ ids: [ID], first: 1 })
  })

  test("an explicit UUID never falls back to a matching identifier on another issue", async () => {
    const issue = { ...linked(), id: "33333333-3333-4333-8333-333333333333" }
    const result = await runCLI([issue], [{ body: envelope([node()]) }])
    expect(result.value).toEqual({ issues: [] })
  })

  test("credential-precedence workspace mismatch never returns foreign metadata", async () => {
    const result = await runCLI([linked()], [{ body: envelope([node("WEB-1971", ID, "foreign")], "foreign") }])
    expect(result.value).toEqual({ issues: [], problem: "workspace" })
    const changedOrg = { ...linked(), key: `linear:33333333-3333-4333-8333-333333333333:${ID}`, id: ID }
    const identity = await runCLI([changedOrg], [{ body: envelope() }])
    expect(identity.value).toEqual({ issues: [], problem: "workspace" })
  })

  test("issue URL mismatch or mismatched identifier is never retained", async () => {
    for (const item of [node("WEB-1971", ID, "foreign"), { ...node(), url: "https://linear.app/acme/issue/WEB-1/other" }]) {
      const result = await runCLI([linked()], [{ body: envelope([item]) }])
      expect(result.value).toEqual({ issues: [], problem: item.url.includes("/foreign/") ? "workspace" : "unavailable" })
    }
  })

  test("partial GraphQL data survives error exit without leaking details", async () => {
    const errors = [{ message: "Private diagnostic", extensions: { code: "INTERNAL_SERVER_ERROR" } }]
    const result = await runCLI([linked(), linked("WEB-2")], [{ body: envelope([node()], "acme", errors), exit: 1 }])
    expect(resultIssues(result.value)).toHaveLength(1)
    expect(result.value).toMatchObject({ problem: "unavailable" })
    expect(JSON.stringify(result.value)).not.toContain("Private diagnostic")
  })

  test.each(["stdout", "stderr"])("classifies rate-limit GraphQL errors from %s", async (stream) => {
    const body = JSON.stringify({ errors: [{ message: "Private", extensions: { code: "RATELIMITED" } }] })
    const reply = stream === "stdout" ? { stdout: body, exit: 1 } : { stderr: body, exit: 1 }
    const result = await runCLI([linked()], [reply])
    expect(result.value).toEqual({ issues: [], problem: "rate-limited" })
  })

  test.each(["No API key configured", "Unauthorized: invalid API key", "Authentication required"])("classifies signed-out CLI error %s", async (stderr) => {
    const result = await runCLI([linked()], [{ stderr, exit: 1 }])
    expect(result.value).toEqual({ issues: [], problem: "signed-out" })
  })

  test("classifies authentication GraphQL errors and missing workspace", async () => {
    const auth = await runCLI([linked()], [{ body: { errors: [{ message: "Private", extensions: { code: "UNAUTHENTICATED" } }] }, exit: 1 }])
    expect(auth.value).toEqual({ issues: [], problem: "signed-out" })
    const workspace = await runCLI([linked()], [{ stderr: "Workspace other not found", exit: 1 }])
    expect(workspace.value).toEqual({ issues: [], problem: "workspace" })
  })

  test("missing CLI is detected without reading real auth", async () => {
    const result = await runCLI([linked()], [], { missing: true })
    expect(result.value).toEqual({ issues: [], problem: "missing" })
    expect(result.calls).toHaveLength(0)
    expect(result.probes).toEqual(["-il"])
  })

  test("a CLI outside the app's PATH is found through the login shell", async () => {
    const issue = linked()
    const result = await runCLI([issue], [{ body: envelope() }], { loginShell: true })
    expect(result.value).toEqual({ issues: [[issue.key, { ...node(), key: `linear:${ORG}:${ID}`, organizationID: ORG, workspace: "acme" }]] })
    expect(result.calls).toHaveLength(1)
    expect(result.probes).toEqual(["-il"])
  })

  test("malformed data and bounded overflow fail safely", async () => {
    for (const reply of [{ stdout: "not json" }, { body: { data: {} } }, { body: { data: { organization: { id: ORG, urlKey: "acme" }, issues: { nodes: [node()] } } } }, { overflow: true }]) {
      const result = await runCLI([linked()], [reply])
      expect(result.value).toMatchObject({ problem: "unavailable" })
    }
  })

  test("validates all metadata and does not invent workflow categories", async () => {
    const invalid = [{ ...node(), id: "not-uuid" }, { ...node(), previousIdentifiers: ["invalid"] }, { ...node(), title: "" }, { ...node(), state: { name: "Review", type: "started", color: "red" } }, { ...node(), state: { name: "Review", type: "started", color: "#00ff00<script>" } }, { ...node(), state: { name: "Review", type: 1, color: "#ffffff" } }]
    const custom = { ...node(), state: { name: "My custom state", type: "started", color: "#AbCdEf" } }
    const [result, ...rejected] = await Promise.all([custom, ...invalid].map((value) => runCLI([linked()], [{ body: envelope([value]) }])))
    for (const item of rejected) expect(item?.value).toEqual({ issues: [], problem: "unavailable" })
    expect(result?.value).toMatchObject({ issues: [[linked().key, { state: custom.state }]] })
  })

  test("ambiguous moved aliases are not assigned to either issue", async () => {
    const nodes = [{ ...node("OPS-1"), previousIdentifiers: ["WEB-1971"] }, { ...node("OPS-2", "33333333-3333-4333-8333-333333333333"), previousIdentifiers: ["WEB-1971"] }]
    const result = await runCLI([linked()], [{ body: envelope(nodes) }])
    expect(result.value).toEqual({ issues: [], problem: "unavailable" })
  })

  test("bounded pagination preserves IDs and uses the returned cursor", async () => {
    const first = envelope([node()])
    first.data.issues.pageInfo = { hasNextPage: true, endCursor: "cursor-1" }
    const result = await runCLI([linked(), linked("WEB-2")], [{ body: first }, { body: envelope([node("WEB-2", "33333333-3333-4333-8333-333333333333")]) }])
    expect(resultIssues(result.value)).toHaveLength(2)
    expect(result.calls).toHaveLength(2)
    const call = result.calls[1]
    if (!Array.isArray(call) || typeof call[3] !== "string") throw new Error("Invalid args")
    expect(JSON.parse(call[3])).toEqual({ ids: ["WEB-1971", "WEB-2"], first: 2, after: "cursor-1" })
  })

  test("pagination cannot retry forever", async () => {
    const body = envelope([])
    body.data.issues.pageInfo = { hasNextPage: true, endCursor: "same" }
    const result = await runCLI([linked(), linked("WEB-2")], [{ body }, { body }])
    expect(result.value).toEqual({ issues: [], problem: "unavailable" })
    expect(result.calls).toHaveLength(2)
  })

  test("moved aliases cannot silently switch identities across pages", async () => {
    const first = envelope([{ ...node("OPS-1"), previousIdentifiers: ["WEB-1971"] }])
    first.data.issues.pageInfo = { hasNextPage: true, endCursor: "next" }
    const second = envelope([{ ...node("OPS-2", "33333333-3333-4333-8333-333333333333"), previousIdentifiers: ["WEB-1971"] }])
    const result = await runCLI([linked(), linked("WEB-2")], [{ body: first }, { body: second }])
    expect(result.value).toEqual({ issues: [], problem: "unavailable" })
  })

  test("abort avoids calls when pre-aborted and cancels an active CLI", async () => {
    const first = await runCLI([linked()], [], { abort: 0 })
    expect(first.calls).toHaveLength(0)
    expect(first.value).toEqual({ issues: [] })
    const started = Date.now()
    const second = await runCLI([linked()], [{ delay: 5000, body: envelope() }], { abort: 200 })
    expect(second.value).toEqual({ issues: [] })
    expect(Date.now() - started).toBeLessThan(2500)
  })

  test("empty input never invokes the CLI", async () => {
    expect(await fetchIssues([])).toEqual({ issues: new Map(), problem: undefined })
  })
})
