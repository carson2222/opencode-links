import { expect, test } from "bun:test"
import { contrastRatio, hexToRgb, readableRgb } from "../src/contrast.ts"
import type { View } from "../src/desktop/contract.ts"
import { chipBudget, fitCount, glance, hiddenSummary, inRowOrder, pageHost } from "../src/desktop/glance.ts"

type PullState = View["pulls"][number]["state"]

const issue = (identifier: string, requested: boolean, type?: string) => ({
  key: identifier,
  identifier,
  title: `Fix ${identifier}`,
  url: `https://linear.app/acme/issue/${identifier}`,
  requested,
  ...(type ? { state: { type, color: "#5e6ad2" } } : {}),
})
const pull = (number: number, state: PullState) => ({
  key: `acme/web#${number}`,
  number,
  repo: "web",
  title: `Change ${number}`,
  url: `https://github.com/acme/web/pull/${number}`,
  state,
})
const page = (label: string, down = false) => ({ key: `http://${label}`, url: `http://${label}`, label, down })
const view = (part: Partial<View>): View => ({ rootID: "root", linear: true, issues: [], pulls: [], pages: [], hidden: false, ...part })
const keys = (chips: ReturnType<typeof glance>) => chips.map((chip) => chip.key)

test("in-flight work outranks settled work", () => {
  const chips = glance(view({
    issues: [issue("REQ-1", true, "started"), issue("REQ-2", true, "completed"), issue("OTH-1", false, "started"), issue("OTH-2", false, "completed"), issue("OTH-3", false)],
    pulls: [pull(9, "closed"), pull(8, "merged"), pull(7, "open"), pull(6, "draft"), pull(5, "unknown")],
    pages: [page("localhost:3000"), page("localhost:4000", true)],
  }))
  expect(keys(chips)).toEqual([
    "REQ-1",
    "acme/web#7", "acme/web#6", "acme/web#5",
    "http://localhost:3000",
    "REQ-2",
    "acme/web#8",
    "OTH-1", "OTH-3",
    "http://localhost:4000",
    "acme/web#9",
    "OTH-2",
  ])
})

test("an unloaded requested issue counts as in flight", () => {
  expect(keys(glance(view({ issues: [issue("REQ-1", true)], pulls: [pull(1, "open")] })))).toEqual(["REQ-1", "acme/web#1"])
})

test("a settled chat still shows its result", () => {
  expect(keys(glance(view({ issues: [issue("REQ-1", true, "completed")], pulls: [pull(1, "merged")] })))).toEqual(["REQ-1", "acme/web#1"])
})

test("chips render in section order, newest first within a section", () => {
  const chips = glance(view({ issues: [issue("REQ-1", true, "completed")], pulls: [pull(2, "merged"), pull(1, "open")], pages: [page("localhost:3000")] }))
  expect(keys(inRowOrder(chips.slice(0, 3)))).toEqual(["REQ-1", "acme/web#1", "http://localhost:3000"])
  expect(keys(inRowOrder(chips))).toEqual(["REQ-1", "acme/web#2", "acme/web#1", "http://localhost:3000"])
})

test("narrow rows get no chips and wide rows a capped share", () => {
  expect(chipBudget(400)).toBe(0)
  expect(chipBudget(559)).toBe(0)
  expect(chipBudget(800)).toBe(240)
  expect(chipBudget(2400)).toBe(400)
})

test("chips fit as a priority prefix", () => {
  expect(fitCount([60, 50, 70], 200, 4)).toBe(3)
  expect(fitCount([60, 50, 70], 150, 4)).toBe(2)
  expect(fitCount([60, 50, 70], 114, 4)).toBe(2)
  expect(fitCount([60, 50, 70], 113, 4)).toBe(1)
  expect(fitCount([60], 0, 4)).toBe(0)
  expect(fitCount([60], -20, 4)).toBe(0)
})

test("the overflow tooltip says what is hidden", () => {
  const chips = glance(view({
    issues: Array.from({ length: 9 }, (_, index) => issue(`ENG-${index}`, false)),
    pulls: [pull(1, "merged"), pull(2, "merged")],
    pages: [page("localhost:3000")],
  }))
  expect(hiddenSummary(chips)).toBe("9 Linear, 2 PRs, 1 local page")
  expect(hiddenSummary(chips.filter((chip) => chip.kind === "pull").slice(0, 1))).toBe("1 PR")
  expect(hiddenSummary([])).toBe("")
})

test("page chips show the host only", () => {
  expect(pageHost(page("web-2356-stable-page-scroll.shop.localhost/app?x=1"))).toBe("web-2356-stable-page-scroll.shop.localhost")
})

test("hex parsing and contrast against measured backgrounds", () => {
  expect(hexToRgb("#abc")).toEqual([170, 187, 204])
  expect(hexToRgb("5e6ad2")).toEqual([94, 106, 210])
  expect(hexToRgb("blue")).toBeUndefined()
  for (const background of [[22, 22, 22], [255, 255, 255]] as const)
    expect(contrastRatio(readableRgb([94, 106, 210], background), background)).toBeGreaterThanOrEqual(4.5)
})
