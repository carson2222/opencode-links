import { createEffect, createSignal, on, onCleanup, onMount } from "solid-js"
import { hexToRgb, readableRgb, rgbToHex, type Rgb } from "../contrast.ts"
import type { View } from "./contract.ts"

export type Colors = "github" | "theme"
export type Mode = "light" | "dark"
export type PullState = View["pulls"][number]["state"]
export type IssueState = View["issues"][number]["state"]

const GITHUB: Record<Mode, Record<Exclude<PullState, "unknown">, string>> = {
  dark: { open: "#3fb950", draft: "#8b949e", merged: "#a371f7", closed: "#f85149" },
  light: { open: "#1a7f37", draft: "#59636e", merged: "#8250df", closed: "#d1242f" },
}

const THEME: Record<Exclude<PullState, "unknown">, string> = {
  open: "var(--v2-state-fg-success)",
  draft: "var(--v2-text-text-muted)",
  merged: "var(--v2-text-text-accent)",
  closed: "var(--v2-state-fg-danger)",
}

export function pullColor(state: PullState, colors: Colors, mode: Mode) {
  if (state === "unknown") return "var(--v2-text-text-base)"
  return colors === "theme" ? THEME[state] : GITHUB[mode][state]
}

export function issueColor(state: IssueState, colors: Colors, background: Rgb | undefined) {
  if (!state) return "var(--v2-text-text-muted)"
  if (colors === "theme") {
    if (state.type === "completed") return THEME.open
    if (state.type === "canceled" || state.type === "duplicate") return THEME.closed
    if (state.type === "started") return THEME.merged
    return THEME.draft
  }
  const raw = hexToRgb(state.color)
  if (!raw) return "var(--v2-text-text-base)"
  return background ? rgbToHex(readableRgb(raw, background)) : state.color
}

let canvas: CanvasRenderingContext2D | null | undefined

function opaque(value: string): Rgb | undefined {
  canvas ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true })
  if (!canvas) return undefined
  canvas.clearRect(0, 0, 1, 1)
  canvas.fillStyle = "rgba(0, 0, 0, 0)"
  canvas.fillStyle = value
  canvas.fillRect(0, 0, 1, 1)
  const [r = 0, g = 0, b = 0, a = 0] = canvas.getImageData(0, 0, 1, 1).data
  return a === 255 ? [r, g, b] : undefined
}

function backgroundOf(element: Element): Rgb | undefined {
  for (let node: Element | null = element; node; node = node.parentElement) {
    const color = opaque(getComputedStyle(node).backgroundColor)
    if (color) return color
  }
  return undefined
}

export function createBackground(element: () => Element | undefined, mode: () => Mode) {
  const [background, setBackground] = createSignal<Rgb | undefined>()
  let frame = 0
  const measure = () => {
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => {
      const target = element()
      if (!target?.isConnected) return
      const next = backgroundOf(target) ?? (mode() === "dark" ? [0, 0, 0] : [255, 255, 255])
      setBackground((previous) => (previous && rgbToHex(previous) === rgbToHex(next) ? previous : next))
    })
  }
  createEffect(on([element, mode], measure))
  onMount(() => {
    const observer = new MutationObserver(measure)
    observer.observe(document.documentElement, { attributes: true })
    observer.observe(document.body, { attributes: true })
    onCleanup(() => {
      observer.disconnect()
      cancelAnimationFrame(frame)
    })
  })
  return background
}
