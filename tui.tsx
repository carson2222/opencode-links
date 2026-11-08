import { Plugin } from "@opencode/plugin/tui"
import { RGBA } from "@opentui/core"
import { execFile } from "node:child_process"
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js"
import type { JSX } from "solid-js"
import type { State } from "./src/github.ts"
import type { Page } from "./src/pages.ts"
import { cleanTitle, fit, scroll, type Pull } from "./src/pulls.ts"
import type { Tracker } from "./src/tracker.ts"
import type { Issues } from "./src/issues.ts"
import type { Issue } from "./src/linear.ts"
import { readableColor } from "./src/color.ts"
import { createLinks, SHOWN_ISSUES, type Links } from "./src/links.ts"
import { createWatch, type Watch } from "./src/watch.ts"
import { tuiHost } from "./src/tui-host.ts"

type Palette = Record<State | "unknown", RGBA>

const GITHUB = {
  dark: { open: "#3fb950", draft: "#8b949e", merged: "#a371f7", closed: "#f85149" },
  light: { open: "#1a7f37", draft: "#59636e", merged: "#8250df", closed: "#d1242f" },
}

const SCROLL = 180

export default Plugin.define({
  id: "opencode-links",
  setup(context) {
    const links = createLinks(tuiHost(context), context.options)
    const { tracker, issues } = links
    const currentRoot = () => {
      const route = context.ui.router.current()
      return route.type === "session" ? context.data.session.root(route.sessionID) : undefined
    }
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "opencode-links.restore",
          title: "Restore hidden links",
          group: "Links",
          palette: true,
          enabled: () => {
            const rootID = currentRoot()
            return rootID !== undefined && tracker.hasHidden(rootID)
          },
          run: async () => {
            const rootID = currentRoot()
            if (rootID === undefined) return
            await tracker.restore(rootID).catch(() => {
              context.ui.toast.show({ message: "Couldn't restore hidden links", variant: "error" })
            })
          },
        },
        {
          id: "opencode-links.link-issue",
          title: "Link issue to this chat",
          group: "Links",
          palette: true,
          enabled: () => issues !== undefined && currentRoot() !== undefined,
          run: async () => {
            const rootID = currentRoot()
            if (!issues || rootID === undefined) return
            const value = await context.ui.dialog.prompt({ title: "Link issue to this chat", placeholder: "Linear issue URL or ticket ID" })
            if (value === undefined) return
            if (currentRoot() !== rootID) {
              context.ui.toast.show({ message: "Chat changed; link not added", variant: "error" })
              return
            }
            try {
              if (!await issues.link(rootID, value))
                context.ui.toast.show({ message: "Enter a Linear issue URL or a configured ticket ID", variant: "error" })
            } catch {
              context.ui.toast.show({ message: "Couldn't link issue", variant: "error" })
            }
          },
        },
      ],
    }))
    const [focus, updateFocus] = context.storage.memory("focus", { initial: { active: true } })
    const onFocus = () => updateFocus((draft) => { draft.active = true })
    const onBlur = () => updateFocus((draft) => { draft.active = false })
    context.renderer.on("focus", onFocus)
    context.renderer.on("blur", onBlur)

    const palette = (): Palette => {
      const theme = context.theme
      if (context.options.colors === "theme")
        return {
          open: theme.text.feedback.success.base,
          draft: theme.text.muted,
          merged: theme.syntax.keyword,
          closed: theme.text.feedback.error.base,
          unknown: theme.text.base,
        }
      const colors = GITHUB[context.themeMode]
      return {
        open: RGBA.fromHex(colors.open),
        draft: RGBA.fromHex(colors.draft),
        merged: RGBA.fromHex(colors.merged),
        closed: RGBA.fromHex(colors.closed),
        unknown: theme.text.base,
      }
    }

    const dispose = context.ui.slot({
      append: "sidebar.content",
      render: (input) => (
        <Section
          sessionID={input.sessionID}
          links={links}
          context={context}
          palette={palette}
          isFocused={() => focus.active}
        />
      ),
    })

    return () => {
      dispose()
      links.dispose()
      context.renderer.off("focus", onFocus)
      context.renderer.off("blur", onBlur)
    }
  },
})

function Section(props: {
  sessionID: string
  links: Links
  context: Plugin.Context
  palette: () => Palette
  isFocused: () => boolean
}) {
  const tracker = props.links.tracker
  const rootID = createMemo(() => props.context.data.session.root(props.sessionID))
  const pulls = createMemo(() => props.links.pulls(rootID()))
  const pages = createMemo(() => props.links.pages(rootID()))
  const issues = createMemo(() => props.links.allIssues(rootID()))
  const [expandedRoot, setExpandedRoot] = createSignal<string | undefined>()
  const expanded = () => expandedRoot() === rootID()
  const shownIssues = createMemo(() => props.links.shownIssues(rootID(), expanded()))
  const digits = createMemo(() => Math.max(0, ...pulls().map((pull) => String(pull.number).length)))
  const [width, setWidth] = createSignal(34)
  const dismiss = (key: string) => {
    void tracker.dismiss(rootID(), key).catch(() => {
      props.context.ui.toast.show({ message: "Couldn't hide link", variant: "error" })
    })
  }
  const hint = () => props.links.pullHint(rootID())

  let watch: Watch | undefined
  createEffect(on(rootID, () => watch?.rootChanged(), { defer: true }))
  createEffect(on(() => props.links.rowsKey(rootID()), () => watch?.update(), { defer: true }))

  onMount(() => {
    const active = createWatch(props.links, { root: rootID, focused: props.isFocused })
    watch = active
    props.context.renderer.on("focus", active.focus)
    props.context.renderer.on("blur", active.blur)
    onCleanup(() => {
      watch = undefined
      active.dispose()
      props.context.renderer.off("focus", active.focus)
      props.context.renderer.off("blur", active.blur)
    })
  })

  return (
    <Show when={pulls().length > 0 || pages().length > 0 || issues().length > 0}>
      <box
        gap={1}
        onSizeChange={function () {
          setWidth(this.width)
        }}
      >
        <Show when={issues().length > 0 && props.links.issues}>
          {(source) => (
            <box>
              <text fg={props.context.theme.text.base}><b>Linear</b></text>
              <For each={shownIssues()}>
                {(issue) => <IssueRow issue={issue} source={source()} neutral={() => props.links.neutralIssue(issue)} width={width()} context={props.context} dismiss={() => {
                  void source().dismiss(rootID(), issue).catch(() => {
                    props.context.ui.toast.show({ message: "Couldn't hide link", variant: "error" })
                  })
                }} />}
              </For>
              <Show when={issues().length > SHOWN_ISSUES}>
                <text fg={props.context.theme.text.muted} onMouseUp={(event) => {
                  if (event.button === 0) setExpandedRoot(expanded() ? undefined : rootID())
                }}>{expanded() ? "Show less" : `Show ${issues().length - SHOWN_ISSUES} more`}</text>
              </Show>
              <Show when={props.links.issueHint()}>
                {(hint) => <text fg={props.context.theme.text.muted}>{hint()}</text>}
              </Show>
            </box>
          )}
        </Show>
        <Show when={pulls().length > 0}>
          <box>
            <text fg={props.context.theme.text.base}>
              <b>Pull requests</b>
            </text>
            <For each={pulls()}>
              {(pull) => (
                <PullRow
                  pull={pull}
                  digits={digits()}
                  width={width()}
                  tracker={tracker}
                  neutral={() => props.links.neutralPull(pull)}
                  context={props.context}
                  palette={props.palette}
                  dismiss={() => dismiss(pull.key)}
                />
              )}
            </For>
            <Show when={hint()}>{(text) => <text fg={props.context.theme.text.muted}>{text()}</text>}</Show>
          </box>
        </Show>
        <Show when={pages().length > 0}>
          <box>
            <text fg={props.context.theme.text.base}>
              <b>Local</b>
            </text>
            <For each={pages()}>
              {(page) => (
                <PageRow
                  page={page}
                  width={width()}
                  tracker={tracker}
                  context={props.context}
                  dismiss={() => dismiss(page.url)}
                />
              )}
            </For>
          </box>
        </Show>
      </box>
    </Show>
  )
}

function IssueRow(props: { issue: Issue; source: Issues; neutral: () => boolean; width: number; context: Plugin.Context; dismiss: () => void }) {
  const info = () => props.source.info(props.issue)
  const color = createMemo(() => {
    const state = info()?.state
    const theme = props.context.theme
    if (!state || props.neutral()) return theme.text.muted
    if (props.context.options.colors === "theme") {
      if (state.type === "completed") return theme.text.feedback.success.base
      if (state.type === "canceled" || state.type === "duplicate") return theme.text.feedback.error.base
      if (state.type === "started") return theme.syntax.keyword
      return theme.text.muted
    }
    return readableColor(state.color, theme.background.raised.base)
  })
  const marquee = createMarquee(
    () => cleanTitle(info()?.title ?? ""),
    () => props.width - props.issue.identifier.length - 3,
  )
  return (
    <LinkRow url={props.issue.url} width={props.width} context={props.context} dismiss={props.dismiss}>
      <text wrapMode="none" onMouseOver={marquee.start} onMouseOut={marquee.stop}>
        <a href={props.issue.url}>
          <span style={{ fg: color() }}>{props.issue.identifier}</span>{" "}
          <span style={{ fg: props.context.theme.text.base }}>{marquee.shown()}</span>
        </a>
      </text>
    </LinkRow>
  )
}

function PullRow(props: {
  pull: Pull
  digits: number
  width: number
  tracker: Tracker
  neutral: () => boolean
  context: Plugin.Context
  palette: () => Palette
  dismiss: () => void
}) {
  const status = () => props.tracker.status(props.pull.key)
  const number = () => `#${props.pull.number}`.padEnd(props.digits + 1)
  const marquee = createMarquee(
    () => cleanTitle(status()?.title ?? ""),
    () => props.width - number().length - props.pull.repo.length - 4,
  )

  return (
    <LinkRow url={props.pull.url} width={props.width} context={props.context} dismiss={props.dismiss}>
      <text wrapMode="none" onMouseOver={marquee.start} onMouseOut={marquee.stop}>
        <a href={props.pull.url}>
          <span style={{ fg: props.palette()[props.neutral() ? "unknown" : status()?.state ?? "unknown"] }}>{number()}</span>{" "}
          <span style={{ fg: props.context.theme.text.muted }}>{props.pull.repo}</span>{" "}
          <span style={{ fg: props.context.theme.text.base }}>{marquee.shown()}</span>
        </a>
      </text>
    </LinkRow>
  )
}

function PageRow(props: { page: Page; width: number; tracker: Tracker; context: Plugin.Context; dismiss: () => void }) {
  const down = () => props.tracker.liveness(props.page.origin) === "down"
  const marquee = createMarquee(
    () => props.page.label,
    () => props.width - 2,
  )

  return (
    <LinkRow url={props.page.url} width={props.width} context={props.context} dismiss={props.dismiss}>
      <text wrapMode="none" onMouseOver={marquee.start} onMouseOut={marquee.stop}>
        <a href={props.page.url}>
          <span style={{ fg: down() ? props.context.theme.text.muted : props.context.theme.text.base }}>
            {marquee.shown()}
          </span>
        </a>
      </text>
    </LinkRow>
  )
}

function LinkRow(props: { url: string; width: number; context: Plugin.Context; dismiss: () => void; children: JSX.Element }) {
  const [hovered, setHovered] = createSignal(false)
  return (
    <box flexDirection="row" onMouseOver={() => setHovered(true)} onMouseOut={() => setHovered(false)}>
      <box
        width={Math.max(0, props.width - 2)}
        flexShrink={1}
        onMouseUp={(event) => {
          if (event.button === 0) {
            event.stopPropagation()
            openUrl(props.url)
          }
        }}
      >
        {props.children}
      </box>
      <text
        width={2}
        flexShrink={0}
        fg={props.context.theme.text.muted}
        onMouseDown={(event) => {
          event.preventDefault()
          event.stopPropagation()
        }}
        onMouseUp={(event) => {
          event.preventDefault()
          event.stopPropagation()
          if (event.button === 0 && hovered()) props.dismiss()
        }}
      >
        {hovered() ? " ×" : "  "}
      </text>
    </box>
  )
}

function createMarquee(text: () => string, room: () => number) {
  const [offset, setOffset] = createSignal<number | undefined>(undefined)
  let timer: ReturnType<typeof setInterval> | undefined
  const stop = () => {
    if (timer) clearInterval(timer)
    timer = undefined
    setOffset(undefined)
  }
  const start = () => {
    if (timer || text().length <= room()) return
    setOffset(0)
    timer = setInterval(() => setOffset((value) => (value ?? 0) + 1), SCROLL)
  }
  onCleanup(stop)
  const shown = () => {
    const at = offset()
    return at === undefined ? fit(text(), room()) : scroll(text(), room(), at)
  }
  return { start, stop, shown }
}

function openUrl(url: string) {
  const [command, args]: [string, string[]] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]]
  execFile(command, args, () => undefined)
}
