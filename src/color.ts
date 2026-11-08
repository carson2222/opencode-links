import { RGBA } from "@opentui/core"
import { contrastRatio, readableRgb, type Rgb } from "./contrast.ts"

function rgb(color: RGBA): Rgb {
  const [r, g, b] = color.toInts()
  return [r ?? 0, g ?? 0, b ?? 0]
}

export function contrast(foreground: RGBA, background: RGBA) {
  return contrastRatio(rgb(foreground), rgb(background))
}

export function readableColor(hex: string, background: RGBA) {
  const [r, g, b] = readableRgb(rgb(RGBA.fromHex(hex)), rgb(background))
  return RGBA.fromInts(r, g, b)
}
