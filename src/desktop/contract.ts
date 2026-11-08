import { Ipc } from "@opencode/plugin/gui"
import { Schema } from "effect"

const Text = Schema.String

export const IssueRow = Schema.Struct({
  key: Text,
  identifier: Text,
  title: Text,
  url: Text,
  requested: Schema.Boolean,
  state: Schema.optional(Schema.Struct({ type: Text, color: Text })),
  stale: Schema.optional(Schema.Boolean),
})

export const PullRow = Schema.Struct({
  key: Text,
  number: Schema.Finite,
  repo: Text,
  title: Text,
  url: Text,
  state: Schema.Literals(["open", "draft", "merged", "closed", "unknown"]),
  stale: Schema.optional(Schema.Boolean),
})

export const PageRow = Schema.Struct({ key: Text, url: Text, label: Text, down: Schema.Boolean })

export const View = Schema.Struct({
  rootID: Text,
  linear: Schema.Boolean,
  issues: Schema.Array(IssueRow),
  pulls: Schema.Array(PullRow),
  pages: Schema.Array(PageRow),
  issueHint: Schema.optional(Text),
  pullHint: Schema.optional(Text),
  hidden: Schema.Boolean,
})

export type View = typeof View.Type

export const Watched = Schema.Struct({ sessionID: Text, active: Schema.Boolean })

export type Watched = typeof Watched.Type

export const RowKind = Schema.Literals(["issue", "pull", "page"])

export type RowKind = typeof RowKind.Type

export const Links = Ipc.define({
  id: "opencode-links.links",
  state: Schema.Struct({ views: Schema.Record(Text, View) }),
  methods: {
    watch: { input: Schema.Struct({ sessions: Schema.Array(Watched) }) },
    dismiss: { input: Schema.Struct({ sessionID: Text, kind: RowKind, key: Text }) },
    restore: { input: Schema.Struct({ sessionID: Text }) },
    link: { input: Schema.Struct({ sessionID: Text, value: Text }), output: Schema.Boolean },
  },
})
