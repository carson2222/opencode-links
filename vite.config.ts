import { gui } from "@opencode/plugin/gui/vite"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [gui()],
  esbuild: { jsx: "automatic", jsxImportSource: "solid-js" },
})
