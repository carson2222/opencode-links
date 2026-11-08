import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { contrast, readableColor } from "../src/color.ts"

test("workflow colors stay readable on light and dark sidebar backgrounds", () => {
  for (const background of ["#222436", "#e1e2e7"])
    for (const color of ["#0f783c", "#f2c94c", "#5e6ad2", "#95a2b3", "#e2e2e2", "#000000", "#ffffff"])
      expect(contrast(readableColor(color, RGBA.fromHex(background)), RGBA.fromHex(background))).toBeGreaterThanOrEqual(4.5)
})

test("already readable workflow colors do not change", () => {
  expect(readableColor("#f2c94c", RGBA.fromHex("#222436")).equals(RGBA.fromHex("#f2c94c"))).toBe(true)
})
