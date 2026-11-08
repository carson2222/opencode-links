/** @jsxImportSource solid-js */
import type { Ui } from "@opencode/plugin/gui"
import { createSignal, For, Show, type JSX } from "solid-js"
import { SHOWN_ISSUES } from "../links.ts"
import type { RowKind, View } from "./contract.ts"
import type { LinksData } from "./data.ts"
import { createBackground, issueColor, pullColor, type Colors, type Mode } from "./look.ts"

export const listCss = `
.ocl-list { display: flex; flex-direction: column; gap: 12px; max-height: min(60vh, 520px); overflow-y: auto; overscroll-behavior: contain; font-family: var(--v2-font-family-sans); font-size: 13px; font-weight: 440; line-height: var(--line-height-compact); letter-spacing: -0.04px; color: var(--v2-text-text-base); }
.ocl-section { display: flex; flex-direction: column; gap: 1px; }
.ocl-heading { position: sticky; top: 0; z-index: 1; background-color: var(--v2-background-bg-layer-01); display: flex; align-items: center; justify-content: space-between; height: 24px; padding: 0 8px; font-size: 12px; letter-spacing: 0.05px; color: var(--v2-text-text-faint); user-select: none; }
.ocl-count { font-variant-numeric: tabular-nums; }
.ocl-row { position: relative; display: flex; align-items: center; height: 28px; border-radius: 8px; transition: background-color 150ms ease-out; }
.ocl-row:hover, .ocl-row:focus-within { background-color: var(--v2-overlay-simple-overlay-hover); }
.ocl-link { display: flex; flex: 1; align-items: center; gap: 8px; min-width: 0; height: 100%; padding: 0 8px; border-radius: 8px; color: inherit; text-decoration: none; cursor: default; outline: none; }
.ocl-link:focus-visible { outline: 1px solid var(--v2-border-border-focus); outline-offset: -1px; }
.ocl-id { flex: none; font-family: var(--font-family-mono); font-size: 12px; font-variant-numeric: tabular-nums; }
.ocl-title { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; mask-image: linear-gradient(to right, #000 calc(100% - 24px), transparent); }
.ocl-title > span { display: inline-block; }
.ocl-row[data-marquee] .ocl-title { mask-image: none; }
.ocl-row[data-marquee] .ocl-title > span { animation: ocl-marquee var(--ocl-duration) linear infinite alternate; }
@keyframes ocl-marquee { 0%, 15% { transform: translateX(0); } 85%, 100% { transform: translateX(calc(-1 * var(--ocl-shift))); } }
:root[data-motion="reduce"] .ocl-row[data-marquee] .ocl-title > span { animation: none; }
@media (prefers-reduced-motion: reduce) { .ocl-row[data-marquee] .ocl-title > span { animation: none; } }
.ocl-muted { color: var(--v2-text-text-muted); }
.ocl-page { font-family: var(--font-family-mono); font-size: 12px; }
.ocl-dead, .ocl-dead .ocl-muted { color: var(--v2-text-text-faint); }
.ocl-hide { flex: none; margin-inline-end: 2px; opacity: 0; transition: opacity 150ms ease-out; }
.ocl-row:hover .ocl-hide, .ocl-row:focus-within .ocl-hide { opacity: 1; }
.ocl-more { height: 28px; padding: 0 8px; border: 0; border-radius: 8px; background: none; color: var(--v2-text-text-muted); font: inherit; text-align: start; cursor: default; transition: background-color 150ms ease-out, color 150ms ease-out; }
.ocl-more:hover, .ocl-more:focus-visible { background-color: var(--v2-overlay-simple-overlay-hover); color: var(--v2-text-text-base); outline: none; }
.ocl-hint, .ocl-empty { padding: 4px 8px; font-size: 12px; color: var(--v2-text-text-faint); }
`

export function LinksList(props: {
  ui: Ui
  data: LinksData
  sessionID: string
  view: View
  colors: Colors
  mode: Mode
  expanded: boolean
  onExpand: (expanded: boolean) => void
}) {
  const [root, setRoot] = createSignal<HTMLDivElement>()
  const background = createBackground(root, () => props.mode)
  const dismiss = (kind: RowKind, key: string) => props.data.dismiss(props.sessionID, kind, key)
  const issues = () => (props.expanded ? props.view.issues : props.view.issues.slice(0, SHOWN_ISSUES))
  const empty = () => props.view.issues.length + props.view.pulls.length + props.view.pages.length === 0

  return (
    <div ref={setRoot} class="ocl-list" data-scrollable>
      <Show when={empty()}>
        <div class="ocl-empty">No links in this chat yet</div>
      </Show>
      <Show when={props.view.issues.length > 0}>
        <Section title="Linear" count={props.view.issues.length} hint={props.view.issueHint}>
          <For each={issues()}>
            {(issue) => (
              <Row ui={props.ui} url={issue.url} open={props.data.open} hide={() => dismiss("issue", issue.key)}>
                <span class="ocl-id" style={{ color: issueColor(issue.stale ? undefined : issue.state, props.colors, background()) }}>
                  {issue.identifier}
                </span>
                <Title>{issue.title}</Title>
              </Row>
            )}
          </For>
          <Show when={props.view.issues.length > SHOWN_ISSUES}>
            <button type="button" class="ocl-more" onClick={() => props.onExpand(!props.expanded)}>
              {props.expanded ? "Show less" : `Show ${props.view.issues.length - SHOWN_ISSUES} more`}
            </button>
          </Show>
        </Section>
      </Show>
      <Show when={props.view.pulls.length > 0}>
        <Section title="Pull requests" count={props.view.pulls.length} hint={props.view.pullHint}>
          <For each={props.view.pulls}>
            {(pull) => (
              <Row ui={props.ui} url={pull.url} open={props.data.open} hide={() => dismiss("pull", pull.key)}>
                <span class="ocl-id" style={{ color: pullColor(pull.stale ? "unknown" : pull.state, props.colors, props.mode) }}>
                  #{pull.number}
                </span>
                <Title>
                  <span class="ocl-muted">{pull.repo}</span> {pull.title}
                </Title>
              </Row>
            )}
          </For>
        </Section>
      </Show>
      <Show when={props.view.pages.length > 0}>
        <Section title="Local" count={props.view.pages.length}>
          <For each={props.view.pages}>
            {(page) => {
              const slash = () => page.label.indexOf("/")
              return (
                <Row ui={props.ui} url={page.url} open={props.data.open} hide={() => dismiss("page", page.key)}>
                  <Title class="ocl-page" dead={page.down}>
                    <Show when={slash() >= 0} fallback={page.label}>
                      {page.label.slice(0, slash())}
                      <span class="ocl-muted">{page.label.slice(slash())}</span>
                    </Show>
                  </Title>
                </Row>
              )
            }}
          </For>
        </Section>
      </Show>
    </div>
  )
}

function Section(props: { title: string; count: number; hint?: string | undefined; children: JSX.Element }) {
  return (
    <section class="ocl-section" aria-label={props.title}>
      <div class="ocl-heading">
        <span>{props.title}</span>
        <span class="ocl-count">{props.count}</span>
      </div>
      {props.children}
      <Show when={props.hint}>{(hint) => <div class="ocl-hint">{hint()}</div>}</Show>
    </section>
  )
}

function Title(props: { class?: string; dead?: boolean; children: JSX.Element }) {
  return (
    <span class={`ocl-title ${props.class ?? ""}`} classList={{ "ocl-dead": props.dead === true }}>
      <span>{props.children}</span>
    </span>
  )
}

function Row(props: { ui: Ui; url: string; open: (url: string) => void; hide: () => void; children: JSX.Element }) {
  const marquee = (row: HTMLDivElement) => {
    const title = row.querySelector<HTMLElement>(".ocl-title")
    const shift = title ? title.scrollWidth - title.clientWidth : 0
    if (shift <= 0) return
    row.style.setProperty("--ocl-shift", `${shift + 8}px`)
    row.style.setProperty("--ocl-duration", `${Math.max(2, shift / 30)}s`)
    row.dataset.marquee = ""
  }
  return (
    <div
      class="ocl-row"
      onPointerEnter={(event) => marquee(event.currentTarget)}
      onPointerLeave={(event) => delete event.currentTarget.dataset.marquee}
    >
      <a
        class="ocl-link"
        href={props.url}
        title={props.url}
        onClick={(event) => {
          event.preventDefault()
          props.open(props.url)
        }}
      >
        {props.children}
      </a>
      <props.ui.IconButton class="ocl-hide" icon="close-small" label="Hide link" size="small" onClick={props.hide} />
    </div>
  )
}
