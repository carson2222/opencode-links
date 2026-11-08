# Linear

The integration is read-only, with no server plugin, extra dependencies or credential store.

## Configuration

Set the plugin options (TUI: `cli.json`; Desktop: the same entry in `opencode.json`):

```json
{
  "package": "opencode-links",
  "options": { "linear": { "workspace": "example", "teams": ["ENG"] } }
}
```

Linear is off by default. `linear: true` tracks canonical issue URLs; the workspace/team object also permits bare task IDs. No workspace/team is hardcoded. Existing `colors: "theme"` applies to issues too; native workflow colors are adjusted for readable text.

## Association

- Explicit root-user task issues and recognized task-command arguments (the older `Work on this Linear …` templates and the current `Start work on the Linear issue IDs or links …` wrapper, scanned only after its `Carson's prompt:` line). Parenthesized notes may accompany ticket lists or label a request's target; incidental tickets in notes are excluded when targets are outside them. In a paragraph that carries a request without its own verb, tickets count in its first sentence, and in later sentences only when the sentence is nothing but tickets. A line naming exactly one ticket counts when that ticket opens it or follows a comma and is followed by a comma or `is` (`ENG-1, what caused…`, `…, ENG-1 is vague, research it`).
- Confirmed successful issue creation/update/start by this chat or its subagents.
- Issue IDs in the title or `--head` of a PR this chat or its subagents created (same proof as PR rows; the current branch only when the same command switched to it first), and in branch names this chat created (`checkout -b`, `switch -c`, `worktree add -b`, `branch <name>`) when that statement provably succeeded.
- Manual `Link issue to this chat` using a URL or configured ID.

Not arbitrary mentions, list/search/view output, comments, relations, example IDs, child briefs, chat titles, PR bodies or base branches, or checking out an existing branch. Bulk updates mean handled issues, not coding ownership. Requested issues come first; five rows initially with expansion. Completed issues remain until hidden. Relinking reveals only that issue.

Detection is conservative. Commands are parsed per statement, so unrelated siblings (`sleep`, `cd`, `git`, literal variables, file writes) don't hide a confirmed create or update. Multiline and `$'…'` quoting, here-strings, heredocs and output piped through `tail -N` are supported. Literal-ID `for` loops are unrolled, and each ID needs its own proof. Output only confirms a statement in order: a create by its printed URL, an update by `✓ Updated issue <ID>` plus its URL, or by its URL alone when piped through `tail`. A silenced update counts when a later `&&` statement prints proof (an echo naming the ID or loop value, or a confirmed chained action), when it is followed directly by `echo …$?` printing 0, or when its exit decides the command's exit (old rule; plain commands only). Update failures exit nonzero (CLI 2.6.0: 1; 3.1.0: 1–5 or 130); output naming the issue in another workspace overrides these exit-based rules. Output lines that appear literally in the command never count. Any statement that could reprint old output (file readers, unsafe echo/printf, interpreters, `linear issue view`/`api`, `git log`/`show`, `gh … view`/`api`, unknown compounds) voids all output proof for that command. Literal, non-help `linear issue relation add` prints only its confirmation line in 2.6.0 and 3.1.0, so it does not void proof. Comment confirmations (`✓ Comment added to ID`/`✓ Comment updated` in 2.6.0, `✓ Added comment to issue ID`/`✓ Updated comment ID` in 3.1.0) attribute their own URLs. URL-only proof is dropped when any other issue URL in the output can't be attributed. PATH or startup-file overrides, aliases and shell functions void the whole command. Start needs explicit ID/workspace and its final state-update line, because it exits 0 when the state change fails. Python loops, background jobs, custom API mutations and unknown command templates may be missed. Manual linking covers them.

## Data and performance

Use the CLI's existing authentication through bounded `linear api` argument-array reads. Batch at 40 and select only detected IDs, title, canonical URL, aliases and workflow metadata. Validate organization and URL workspace; environment/project credentials can override `--workspace`.

Store organization/issue UUID identity and identifier aliases. In Desktop, Electron main runs all CLI reads; windows never do. Team moves, enrichment and reopen must not undo dismissal. Issues follow the shared view-first cadence in `AGENTS.md`: entry re-reads rows older than 15 seconds; active rows refresh every 60 seconds after a change and 120 seconds when quiet (an explicit `refresh` caps both); completed/canceled/duplicate rows every 10 minutes because they can reopen; background chats only ride along on foreground requests. Every non-dismissed issue of a watched, focused chat refreshes, not only the five shown. A detected update re-reads after the command succeeds; a PR state change re-reads the chat's issues at +3 s and +15 s, stopping once the issue is done. Shared claims dedupe concurrent reads; failures back off without removing cached rows.

One history pass serves PRs and tickets. Versioned checkpoints migrate older chats; root user requests appear before deep child history. Request detection has its own version, so request-only fixes replay root user messages without rescanning assistant or child transcripts. Successful chunks persist independently. Blur/unmount cancels remaining work.

On October 8, 2026, the large 249-child real chat's first legacy-cache backfill read about 239 MB in 18 seconds through the CLI-backed probe; a subsequent warm scan read about 0.56 MB in 0.32 seconds. These are API transport measurements, not frame-latency benchmarks. The first scan's cost is a known tradeoff for historical recovery, not repeated focus work.

## Verification and remaining work

Replay against ten real chat families recovered their named targets and adopted issues, while planning/retro and skill examples stayed empty. A bulk-creation sample recovered all eleven created tickets, including piped creation output. This is a bounded fixture result, not a universal accuracy guarantee.

Keep unit/type checks and real TUI gates from `AGENTS.md`. Test missing/auth/mismatched-workspace responses with shims, never by changing real credentials. CLI 3.1.0 create, update, comment and relation output and the metadata read are verified against real history; its `issue start` is verified from source only, since no real start call exists yet. Native modifier-click and remote-server behavior remain unverified. A resizable detail panel, MCP discovery, OAuth and a stable public adapter API are deferred.
