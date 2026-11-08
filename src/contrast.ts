export type Rgb = readonly [number, number, number]

export function hexToRgb(hex: string): Rgb | undefined {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!match?.[1]) return undefined
  const digits = match[1].length === 3 ? [...match[1]].map((digit) => digit + digit).join("") : match[1]
  const channel = (start: number) => parseInt(digits.slice(start, start + 2), 16)
  return [channel(0), channel(2), channel(4)]
}

export function rgbToHex(color: Rgb) {
  return `#${color.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`
}

function luminance(color: Rgb) {
  const [r, g, b] = color.map((channel) => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0)
}

export function contrastRatio(foreground: Rgb, background: Rgb) {
  const a = luminance(foreground)
  const b = luminance(background)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

export function readableRgb(color: Rgb, background: Rgb): Rgb {
  const [r, g, b] = color
  const target = luminance(background) > 0.179 ? 0 : 255
  for (let step = 0; step <= 20; step++) {
    const amount = step / 20
    const mixed: Rgb = [
      Math.round(r + (target - r) * amount),
      Math.round(g + (target - g) * amount),
      Math.round(b + (target - b) * amount),
    ]
    if (contrastRatio(mixed, background) >= 4.5) return mixed
  }
  return [target, target, target]
}
