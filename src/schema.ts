import { Schema, Struct } from "effect"

const Draft = <const F extends Schema.Struct.Fields>(fields: F) => Schema.Struct(Struct.map(fields, Schema.mutableKey))
const Dict = <V extends Schema.Constraint>(value: V) => Schema.Record(Schema.String, Schema.mutableKey(value))
const List = <S extends Schema.Constraint>(item: S) => Schema.mutable(Schema.Array(item))
const Time = Schema.Finite

export const Problem = Schema.Literals(["missing", "signed-out", "workspace", "rate-limited", "unavailable"])

export const Pull = Draft({
  key: Schema.String,
  url: Schema.String,
  host: Schema.String,
  owner: Schema.String,
  repo: Schema.String,
  number: Schema.Finite,
  created: Time,
})

export const Page = Draft({
  url: Schema.String,
  origin: Schema.String,
  label: Schema.String,
  created: Time,
  aliases: Schema.optional(List(Schema.String)),
})

export const Checkpoint = Draft({
  mark: Time,
  idle: Schema.optional(Time),
  extraMark: Schema.optional(Time),
  extraIdle: Schema.optional(Time),
  version: Schema.optional(Schema.Finite),
  pagesVersion: Schema.optional(Schema.Finite),
  pullsVersion: Schema.optional(Schema.Finite),
})

export const Chat = Draft({
  pulls: List(Pull),
  pages: Schema.optional(List(Page)),
  logs: Schema.optional(List(Schema.String)),
  checkpoints: Schema.optional(Dict(Schema.Union([Checkpoint, Time]))),
  userCheckpoint: Schema.optional(Checkpoint),
  pullsUserCheckpoint: Schema.optional(Checkpoint),
  touched: Time,
})

export const PullState = Schema.Literals(["open", "draft", "merged", "closed"])

export const Known = Draft({
  title: Schema.String,
  state: Schema.Union([PullState, Schema.Literal("unknown")]),
  checked: Time,
})

export const Issue = Draft({
  key: Schema.String,
  id: Schema.optional(Schema.String),
  workspace: Schema.String,
  identifier: Schema.String,
  url: Schema.String,
  created: Time,
  requested: Schema.Boolean,
})

const issueInfo = {
  key: Schema.String,
  id: Schema.String,
  organizationID: Schema.String,
  workspace: Schema.String,
  identifier: Schema.String,
  previousIdentifiers: List(Schema.String),
  title: Schema.String,
  url: Schema.String,
  state: Draft({ name: Schema.String, type: Schema.String, color: Schema.String }),
}

export const IssueInfo = Draft(issueInfo)

export const Claim = Draft({
  checked: Time,
  owner: Schema.optional(Schema.String),
  until: Schema.optional(Time),
  attempts: Schema.optional(Schema.Finite),
  retry: Schema.optional(Time),
  unchanged: Schema.optional(Schema.Finite),
})

const Counts = Draft({
  requests: Schema.Finite,
  failed: Schema.Finite,
  loads: Schema.Finite,
  keys: Schema.Finite,
  background: Schema.Finite,
  batches: List(Schema.Finite),
})
export const Failure = Draft({ problem: Problem, until: Time, attempts: Schema.Finite })

export const schemas = {
  chats: Draft({ byRoot: Dict(Chat) }),
  status: Draft({ byKey: Dict(Known) }),
  linear: Draft({
    byRoot: Dict(Draft({ items: List(Issue), touched: Time })),
    byKey: Dict(Draft({ ...issueInfo, checked: Time })),
    aliases: Dict(Schema.String),
    organizations: Dict(Schema.String),
  }),
  hidden: Draft({ byRoot: Dict(Dict(Schema.Literal(true))) }),
  "refresh.github": Draft({ claims: Dict(Claim), failures: Dict(Failure), dirty: Schema.optional(Dict(List(Time))), rechecks: Schema.optional(Dict(List(Time))) }),
  "refresh.linear": Draft({ claims: Dict(Claim), failures: Dict(Failure), dirty: Schema.optional(Dict(List(Time))), rechecks: Schema.optional(Dict(List(Time))) }),
  viewed: Draft({ byRoot: Dict(Time) }),
  stats: Draft({
    hours: Dict(Draft({ github: Counts, linear: Counts, entries: Schema.Finite, ages: List(Schema.Finite), latency: List(Schema.Finite) })),
  }),
}
