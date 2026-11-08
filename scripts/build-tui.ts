// OpenTUI's Solid transform skips node_modules, so an npm install needs compiled JSX.
// Shared modules resolve to the host's runtime instances, keeping signals and renderables in one copy.
import { runtimeModuleIdForSpecifier } from "@opentui/core/runtime-plugin"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

const SHARED = new Set(["@opencode/plugin/tui", "@opentui/core", "@opentui/solid", "solid-js", "solid-js/store"])

const result = await Bun.build({
  entrypoints: ["./tui.tsx"],
  outdir: "./dist",
  target: "bun",
  format: "esm",
  packages: "external",
  external: ["opentui:*"],
  plugins: [
    createSolidTransformPlugin({
      moduleName: runtimeModuleIdForSpecifier("@opentui/solid"),
      resolvePath: (specifier) => (SHARED.has(specifier) ? runtimeModuleIdForSpecifier(specifier) : null),
    }),
  ],
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
