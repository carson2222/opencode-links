/** @jsxImportSource solid-js */
import type { Context, MountedSession } from "@opencode/plugin/gui"
import { createEffect, createMemo, createSignal, For, onCleanup, Show, type JSX } from "solid-js"
import type { LinksData } from "./data.ts"
import type { LinksDialog } from "./dialog.tsx"
import { chipBudget, fitCount, glance, hiddenSummary, inRowOrder, pageHost, type Chip } from "./glance.ts"
import { createBackground, issueColor, pullColor, type Colors } from "./look.ts"

const CANDIDATES = 8
const GAP = 4
const HINT_WIDTH = 22

export const headerCss = `
.ocl-chips { position: relative; display: flex; align-items: center; gap: ${GAP}px; flex: none; }
.ocl-chip { display: inline-block; flex: none; height: 24px; max-width: 140px; padding: 0 8px; border: 0; border-radius: 9999px; background-color: var(--v2-overlay-simple-overlay-hover); color: var(--v2-text-text-base); font-family: var(--font-family-mono); font-size: 12px; font-weight: 440; line-height: 24px; letter-spacing: 0.05px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: default; transition: background-color 150ms ease-out; }
.ocl-chip:hover, .ocl-chip:focus-visible { background-color: var(--v2-overlay-simple-overlay-pressed); }
.ocl-chip:focus-visible { outline: 1px solid var(--v2-border-border-focus); outline-offset: 1px; }
.ocl-chip[data-dead] { color: var(--v2-text-text-faint); }
.ocl-chip-more { display: inline-flex; align-items: center; gap: 4px; font-family: var(--v2-font-family-sans); color: var(--v2-text-text-muted); }
.ocl-chip-more:hover { color: var(--v2-text-text-base); }
.ocl-chips-hint { display: inline-flex; flex: none; width: ${HINT_WIDTH}px; justify-content: center; color: var(--v2-icon-icon-muted); }
.ocl-chips-measure { position: absolute; inset-inline-start: 0; top: 0; width: 0; height: 0; overflow: hidden; visibility: hidden; pointer-events: none; }
.ocl-chips-measure > div { display: flex; gap: ${GAP}px; width: max-content; }
`

export function HeaderChips(props: { ctx: Context; data: LinksData; dialog: LinksDialog; colors: Colors; session: MountedSession; active: boolean }) {
  const [root, setRoot] = createSignal<HTMLDivElement>()
  const [measure, setMeasure] = createSignal<HTMLDivElement>()
  const [rowWidth, setRowWidth] = createSignal(0)
  const [widths, setWidths] = createSignal<{ chips: readonly number[]; more: number }>({ chips: [], more: 0 })
  const background = createBackground(root, () => props.ctx.appearance.mode())
  const session = () => (props.session.server.builtin ? props.session : undefined)
  props.data.watch({ session, active: () => props.active })
  const view = () => props.data.view(session()?.id)

  const ranked = createMemo(() => {
    const current = view()
    return current ? glance(current) : []
  })
  const candidates = createMemo(() => ranked().slice(0, CANDIDATES))
  const hints = () => [view()?.issueHint, view()?.pullHint].filter((hint) => hint !== undefined)

  createEffect(() => {
    const element = root()
    const row = element?.closest(".session-header-layout") ?? element?.parentElement
    if (!row) return
    const observer = new ResizeObserver(() => setRowWidth(row.clientWidth))
    observer.observe(row)
    setRowWidth(row.clientWidth)
    onCleanup(() => observer.disconnect())
  })

  createEffect(() => {
    const element = measure()
    candidates()
    if (!element) return
    const read = () => {
      const children = [...element.children].filter((child) => child instanceof HTMLElement)
      const more = children.at(-1)?.offsetWidth ?? 0
      setWidths({ chips: children.slice(0, -1).map((child) => child.offsetWidth), more })
    }
    const observer = new ResizeObserver(read)
    observer.observe(element)
    read()
    onCleanup(() => observer.disconnect())
  })

  const shownCount = () => {
    const budget = chipBudget(rowWidth()) - widths().more - GAP - (hints().length > 0 ? HINT_WIDTH + GAP : 0)
    return Math.min(candidates().length, fitCount(widths().chips, budget, GAP))
  }
  const shown = () => inRowOrder(candidates().slice(0, shownCount()))
  const hidden = () => ranked().slice(shownCount())

  const manage = () => {
    const target = session()
    if (target) props.dialog(target)
  }

  return (
    <Show when={ranked().length > 0}>
      <div ref={setRoot} class="ocl-chips" data-component="ocl-chips">
        <div class="ocl-chips-measure" aria-hidden="true">
          <div ref={setMeasure}>
            <For each={candidates()}>{(chip) => <ChipButton {...chipView(chip)} />}</For>
            <span class="ocl-chip ocl-chip-more">+{ranked().length}</span>
          </div>
        </div>
        <For each={shown()}>
          {(chip) => {
            const look = () => chipView(chip)
            return (
              <Tip ctx={props.ctx} value={look().tip}>
                <ChipButton {...look()} onClick={() => props.data.open(chip.row.url)} />
              </Tip>
            )
          }}
        </For>
        <Show when={hints().length > 0}>
          <Tip ctx={props.ctx} value={<For each={hints()}>{(hint) => <div>{hint}</div>}</For>}>
            <span class="ocl-chips-hint" role="img" aria-label={hints().join(". ")}>
              <props.ctx.ui.Icon name="warning" size="small" />
            </span>
          </Tip>
        </Show>
        <Tip ctx={props.ctx} value={hidden().length > 0 ? `More: ${hiddenSummary(hidden())}` : "All links"}>
          <button type="button" class="ocl-chip ocl-chip-more" aria-label="All links" onClick={manage}>
            <Show when={hidden().length > 0} fallback={<props.ctx.ui.Icon name="outline-dots" size="small" />}>
              {shown().length > 0 ? `+${hidden().length}` : `${hidden().length} links`}
            </Show>
          </button>
        </Tip>
      </div>
    </Show>
  )

  function chipView(chip: Chip): { text: string; tip: string; color?: string; dead?: boolean } {
    if (chip.kind === "issue")
      return { text: chip.row.identifier, tip: chip.row.title || chip.row.url, color: issueColor(chip.row.stale ? undefined : chip.row.state, props.colors, background()) }
    if (chip.kind === "pull")
      return {
        text: `#${chip.row.number}`,
        tip: `${chip.row.repo} ${chip.row.title}`.trim(),
        color: pullColor(chip.row.stale ? "unknown" : chip.row.state, props.colors, props.ctx.appearance.mode()),
      }
    return { text: pageHost(chip.row), tip: chip.row.url, dead: chip.row.down }
  }
}

function ChipButton(props: { text: string; color?: string | undefined; dead?: boolean | undefined; onClick?: () => void }) {
  return (
    <button
      type="button"
      class="ocl-chip"
      tabIndex={props.onClick ? undefined : -1}
      style={props.color ? { color: props.color } : undefined}
      data-dead={props.dead ? "" : undefined}
      onClick={() => props.onClick?.()}
    >
      {props.text}
    </button>
  )
}

function Tip(props: { ctx: Context; value: JSX.Element; children: JSX.Element }) {
  return (
    <props.ctx.ui.Tooltip value={props.value} placement="bottom">
      {props.children}
    </props.ctx.ui.Tooltip>
  )
}
