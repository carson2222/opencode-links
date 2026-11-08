import { expect, test } from "bun:test"
import { createIssues } from "../src/issues.ts"
import { createHidden } from "../src/hidden.ts"
import { issueIn } from "../src/linear.ts"
import { tuiHost } from "../src/tui-host.ts"

const options = { workspace: "acme", teams: ["WEB"] }
const organizationID = "11111111-1111-4111-8111-111111111111"
const id = "22222222-2222-4222-8222-222222222222"
const canonical = `linear:${organizationID}:${id}`
const reference = () => issueIn("WEB-1971", 100, options, true)
const metadata = () => ({
  key: canonical, id, organizationID, workspace: "acme", identifier: "WEB-1971", previousIdentifiers: [],
  title: "Preview tiles", url: "https://linear.app/acme/issue/WEB-1971/preview-tiles",
  state: { name: "In Review", type: "started", color: "#0f783c" },
})

function fixture(shared = new Map(), loader) {
  const context = { storage: { store(key, options) {
    const state = shared.get(key) ?? structuredClone(options.initial)
    shared.set(key, state)
    return [state, async (mutation) => mutation(state)]
  } } }
  const host = tuiHost(context)
  const hidden = createHidden(host)
  let calls = 0
  let value = metadata()
  const source = createIssues(host, 60_000, options, hidden, async (items, signal) => {
    calls++
    return loader ? loader(items, signal) : { issues: new Map(items.map((item) => [item.key, structuredClone(value)])) }
  })
  return { source, hidden, shared, get calls() { return calls }, setValue(next) { value = next } }
}

test("manual links are scoped, validated, read-only and enrich once", async () => {
  const f = fixture()
  try {
    expect(await f.source.link("root", "not a ticket")).toBe(false)
    expect(await f.source.link("root", "WEB-1971")).toBe(true)
    expect(f.calls).toBe(0)
    expect(f.source.issues("other")).toEqual([])
    await f.source.refresh(f.source.issues("root"), new AbortController().signal)
    const issue = f.source.issues("root")[0]
    expect(issue.key).toBe(canonical)
    expect(issue.url).toBe(metadata().url)
    expect(f.source.info(issue).state).toEqual(metadata().state)
    await f.source.refresh(f.source.issues("root"), new AbortController().signal)
    expect(f.calls).toBe(1)
  } finally { f.source.dispose() }
})

test("a dismissal before resolution survives an in-flight result and reopening", async () => {
  let finish
  const response = new Promise((resolve) => { finish = resolve })
  const f = fixture(new Map(), async (items) => {
    await response
    return { issues: new Map(items.map((item) => [item.key, metadata()])) }
  })
  let reopened
  try {
    await f.source.extension.save("root", [reference()])
    const original = f.source.issues("root")[0]
    const pending = f.source.refresh([original], new AbortController().signal)
    await f.source.dismiss("root", original)
    finish()
    await pending
    expect(f.source.issues("root")).toEqual([])
    reopened = fixture(new Map(structuredClone([...f.shared])))
    expect(reopened.source.issues("root")).toEqual([])
    await reopened.hidden.restore("root")
    expect(reopened.source.issues("root")[0].key).toBe(canonical)
  } finally { finish(); f.source.dispose(); reopened?.source.dispose() }
})

test("canonical identity dedupes moved aliases and hidden rows remain hidden", async () => {
  const f = fixture()
  try {
    await f.source.extension.save("root", [reference()])
    await f.source.refresh(f.source.issues("root"), new AbortController().signal)
    const before = f.source.issues("root")[0]
    await f.source.dismiss("root", before)
    f.setValue({ ...metadata(), identifier: "ENG-99", previousIdentifiers: ["WEB-1971"], url: "https://linear.app/acme/issue/ENG-99/preview-tiles" })
    f.shared.get("linear").byKey[canonical].checked = 0
    f.shared.get("refresh.linear").claims = {}
    await f.source.refresh([before], new AbortController().signal)
    const alias = issueIn("https://linear.app/acme/issue/ENG-99", 200, options)
    await f.source.extension.save("root", [alias])
    expect(f.source.issues("root")).toEqual([])
    await f.hidden.restore("root")
    expect(f.source.issues("root")).toHaveLength(1)
    expect(f.source.issues("root")[0].identifier).toBe("ENG-99")
    expect(f.source.issues("root")[0].requested).toBe(true)
  } finally { f.source.dispose() }
})

test("relinking a hidden issue reveals only that issue", async () => {
  const f = fixture()
  try {
    await f.source.link("root", "WEB-1971")
    await f.source.refresh(f.source.issues("root"), new AbortController().signal)
    await f.source.dismiss("root", f.source.issues("root")[0])
    await f.hidden.dismiss("root", "another-link")
    await f.source.link("root", "WEB-1971")
    expect(f.source.issues("root")).toHaveLength(1)
    expect(f.hidden.contains("root", ["another-link"])).toBe(true)
  } finally { f.source.dispose() }
})

test("two windows share enrichment and dismissals", async () => {
  const shared = new Map()
  const a = fixture(shared)
  const b = fixture(shared)
  try {
    await a.source.extension.save("root", [reference()])
    await a.source.refresh(a.source.issues("root"), new AbortController().signal)
    await b.source.refresh(b.source.issues("root"), new AbortController().signal)
    expect(a.calls + b.calls).toBe(1)
    await b.source.dismiss("root", b.source.issues("root")[0])
    expect(a.source.issues("root")).toEqual([])
    await a.hidden.restore("root")
    expect(b.source.issues("root")).toHaveLength(1)
  } finally { a.source.dispose(); b.source.dispose() }
})

test("workspace identity cannot silently change after it has been pinned", async () => {
  const f = fixture()
  try {
    await f.source.extension.save("root", [reference()])
    await f.source.refresh(f.source.issues("root"), new AbortController().signal)
    f.setValue({ ...metadata(), key: `linear:33333333-3333-4333-8333-333333333333:${id}`, organizationID: "33333333-3333-4333-8333-333333333333", title: "Wrong workspace" })
    f.shared.get("linear").byKey[canonical].checked = 0
    f.shared.get("refresh.linear").claims = {}
    await f.source.refresh(f.source.issues("root"), new AbortController().signal)
    expect(f.source.problem()).toBe("workspace")
    expect(f.source.info(f.source.issues("root")[0]).title).toBe("Preview tiles")
  } finally { f.source.dispose() }
})

test("visiting unchanged issues keeps membership alive beyond the cache retention window", async () => {
  const f = fixture()
  try {
    await f.source.extension.save("root", [reference()])
    f.shared.get("linear").byRoot.root.touched = 0
    await f.source.extension.save("root", [])
    await f.source.extension.save("other", [reference()])
    expect(f.source.issues("root")).toHaveLength(1)
  } finally { f.source.dispose() }
})

test("a dirty mark made under the identifier alias during first enrichment follows the issue to its UUID key", async () => {
  let release
  const f = fixture(new Map(), async (items) => {
    await new Promise((resolve) => { release = resolve })
    return { issues: new Map(items.map((item) => [item.key, metadata()])) }
  })
  try {
    await f.source.extension.save("root", [reference()])
    const pending = f.source.refresh(f.source.issues("root"), new AbortController().signal)
    await Bun.sleep(150)
    await f.source.extension.dirty("root", [Date.now()])
    release()
    await pending
    const refresh = f.shared.get("refresh.linear")
    expect(refresh.dirty?.[reference().key]).toBeUndefined()
    expect(refresh.claims[reference().key]).toBeUndefined()
    expect(refresh.dirty[canonical]).toHaveLength(1)
    expect(f.source.due(f.source.issues("root"))).toBeLessThanOrEqual(Date.now())
  } finally { release?.(); f.source.dispose() }
})
