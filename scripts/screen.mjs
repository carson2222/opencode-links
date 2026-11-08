// bun run screen [--cols 170] [--rows 45] [--wait 8000] [--from 0] [--color] [--html out.html] [--keys "a@ms,b@ms"] [--cwd dir] -- cmd args
// Runs a command in a pseudo terminal and prints the final screen. --color tags each run with {fg}. Each key is written, then the harness waits its @ms. \e is ESC, \r is Enter.
import pty from "node-pty"
import xterm from "@xterm/headless"
import fs from "node:fs"

const argv = process.argv.slice(2)
const sep = argv.indexOf("--")
const opts = argv.slice(0, sep)
const cmd = argv.slice(sep + 1)
const get = (name, fallback) => {
  const i = opts.indexOf(`--${name}`)
  return i === -1 ? fallback : opts[i + 1]
}
const cols = Number(get("cols", 170))
const rows = Number(get("rows", 45))
const wait = Number(get("wait", 8000))
const from = Number(get("from", 0))
const color = opts.includes("--color")
const keys = get("keys", "")
const cwd = get("cwd", process.cwd())

const term = new xterm.Terminal({ cols, rows, allowProposedApi: true })
const proc = pty.spawn(cmd[0], cmd.slice(1), {
  name: "xterm-256color",
  cols,
  rows,
  cwd,
  env: { ...process.env, COLORTERM: "truecolor", TERM: "xterm-256color" },
})
proc.onData((d) => term.write(d))

const hex = (cell) => {
  if (cell.isFgDefault()) return "def"
  const v = cell.getFgColor()
  if (cell.isFgRGB()) return "#" + v.toString(16).padStart(6, "0")
  return "p" + v
}

const bgHex = (cell) => (cell.isBgRGB() ? "#" + cell.getBgColor().toString(16).padStart(6, "0") : "#1e2030")
const html = () => {
  const buf = term.buffer.active
  const esc = (c) => (c === "<" ? "&lt;" : c === "&" ? "&amp;" : c === ">" ? "&gt;" : c)
  let out = ""
  for (let y = 0; y < rows; y++) {
    const line = buf.getLine(buf.viewportY + y)
    if (!line) continue
    let s = ""
    for (let x = from; x < cols; x++) {
      const cell = line.getCell(x)
      if (!cell) break
      const fg = cell.isFgRGB() ? "#" + cell.getFgColor().toString(16).padStart(6, "0") : "#c8d3f5"
      const style = `color:${fg};background:${bgHex(cell)};${cell.isBold() ? "font-weight:700;" : ""}${cell.isUnderline() ? "text-decoration:underline;" : ""}`
      s += `<span style="${style}">${esc(cell.getChars() || " ")}</span>`
    }
    out += `<div>${s}</div>`
  }
  return `<html><body style="margin:0;background:#111"><pre style="margin:0;font:15px/1.25 'JetBrains Mono',Menlo,monospace">${out}</pre></body></html>`
}

const dump = () => {
  const buf = term.buffer.active
  const out = []
  for (let y = 0; y < rows; y++) {
    const line = buf.getLine(buf.viewportY + y)
    if (!line) continue
    if (!color) {
      out.push(line.translateToString(true).slice(from))
      continue
    }
    let s = ""
    let last = ""
    for (let x = from; x < cols; x++) {
      const cell = line.getCell(x)
      if (!cell) break
      const c = cell.getChars() || " "
      const fg = c.trim() ? hex(cell) : last
      if (fg !== last) {
        s += `{${fg}${cell.isBold() ? ",b" : ""}${cell.isUnderline() ? ",u" : ""}}`
        last = fg
      }
      s += c
    }
    out.push(s.trimEnd())
  }
  return out.join("\n")
}

const steps = keys ? keys.split(",") : []
let t = wait
for (const k of steps) {
  const [key, delay] = k.split("@")
  t += Number(delay || 500)
  setTimeout(() => proc.write(key.replace(/\\r/g, "\r").replace(/\\e/g, "\x1b")), t - Number(delay || 500))
}
setTimeout(() => {
  const out = get("html", "")
  if (out) fs.writeFileSync(out, html())
  process.stdout.write(dump() + "\n")
  proc.kill()
  process.exit(0)
}, t + 1500)
