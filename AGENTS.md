# opencode-links

OpenCode plugin (TUI sidebar, Desktop header chips) listing the PRs, Linear issues and local pages each chat produced. `README.md` is the user-facing contract; the tests are the detection spec.

## Rules

- Product calls are Carson's. Ask before changing anything users see or which links count.
- One chat and its subagents only. A missed link beats a wrong one. Never infer a status from a command.
- Read-only: never write to GitHub or Linear. Only a visible chat in a focused window starts network work.
- Storage keys derive from the plugin id. Never change ids or hidden-link keys without a migration.
- Never mention or credit other plugins or products.

## Test

- `bun test`, `bunx tsc --noEmit`, `bun run build`; on macOS also `bun run smoke` and `bun run smoke:refresh`.
- Never touch Carson's live OpenCode or Desktop. Run the real TUI with `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME` (and `XDG_CONFIG_HOME` for a signed-out `gh`) in a temp dir and `opencode --standalone`; `bun run screen` prints the render. Never mutate real PRs or tickets to test.
- Detection changes: replay real history from `~/.local/share/opencode/opencode.db` (read-only, `?mode=ro`) against independently expected links, not against the detector itself.
- Packaging changes: `npm pack`, then load `opencode-links@file:<tarball>` in the sandbox. npm installs need the compiled `dist/tui.js`; a local path entry hides that.

## Release

Every change is a PR to `main`. Bump `version` in the PR to release; merging publishes to npm and creates the GitHub release.
