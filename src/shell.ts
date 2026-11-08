type Part = { text: string } | { name: string }
export type Word = { parts: Part[]; opaque: boolean; quoted: boolean }
type Redirect = { fd: number; op: string; target: Word }
type Token = { type: "word"; word: Word; command: boolean } | { type: "op"; op: string } | { type: "redirect"; redirect: Redirect }
type Link = "and" | "or" | "then" | "background" | "end"
type Stage = { words: Word[]; redirects: Redirect[] }
type Binding = { name: string; value: string }
type Node = { stages: Stage[]; link: Link; compound?: "group" | "function"; binding?: Binding; inner?: Node[]; subshell?: boolean }
type Stream = "out" | "pipe" | "null" | "other"
export type Statement = {
  words: Word[]; stages: (string | undefined)[][]; out: Stream; visible: boolean; plain: boolean
  link: Link; prev?: Link; compound?: "group" | "function"; binding?: Binding; writes: (string | undefined)[]; errors: Stream
  inner?: Statement[]; subshell?: boolean
}

const HEREDOC = /(?<!<)<<(?!<)-?\s*(['"]?)(\w+)\1([^\n]*)\n[\s\S]*?(?:\n[\t ]*\2[\t ]*(?=\n|$)|$)/g

export function invocation(statement: Statement): { name: string; args: (string | undefined)[] } | undefined {
  if (statement.compound) return undefined
  let index = commandIndex(statement)
  if (index < 0) return undefined
  if (literal(statement.words[index]) === "snip") index++
  const name = literal(statement.words[index])
  return name === undefined ? undefined : { name: name.split("/").at(-1) ?? "", args: statement.words.slice(index + 1).map(literal) }
}

export function exitUnknown(statement: Statement): boolean {
  return statement.prev === "or" || statement.link === "background"
}

export function andToEnd(statements: readonly Statement[], index: number): boolean {
  return statements.slice(index, -1).every(({ link }) => link === "and")
}

export function commandIndex(statement: Statement): number {
  return statement.words.findIndex((word) => !assignment(word))
}

export function literal(word: Word | undefined): string | undefined {
  if (!word || word.opaque || !word.parts.every((part) => "text" in part)) return undefined
  return word.parts.map((part) => "text" in part ? part.text : "").join("")
}

export function pathText(word: Word | undefined): string | undefined {
  const [first, ...rest] = word?.parts ?? []
  if (!word || word.opaque || !first) return undefined
  return literal("name" in first && first.name === "HOME" ? { ...word, parts: [{ text: "~" }, ...rest] } : word)
}

const NESTED = /\(((?:[^()'"]|'[^']*'|"(?:\\.|[^"\\])*")*)\)|`([^`]*)`|(?<=^|[\s;&|])\{\s((?:[^{}'"]|'[^']*'|"(?:\\.|[^"\\])*")*)\}/g

export function nestedCommands(command: string): string[] {
  return [...command.replace(/'[^']*'/g, "''").matchAll(NESTED)].map((match) => match[1] ?? match[2] ?? match[3] ?? "")
}

export function literals(words: readonly Word[]): string[] | undefined {
  const values = words.map(literal)
  return values.every((value) => value !== undefined) ? values : undefined
}

export function literalPrefix(word: Word): string {
  const first = word.parts[0]
  return first && "text" in first ? first.text : ""
}

export function assignment(word: Word): boolean {
  return /^[a-z_]\w*=/i.test(literalPrefix(word))
}

function substitute(word: Word, values: ReadonlyMap<string, string>): Word {
  const parts: Part[] = []
  for (const part of word.parts) {
    const value = "name" in part ? values.get(part.name) : part.text
    const last = parts.at(-1)
    if (value === undefined) parts.push(part)
    else if (last && "text" in last) parts[parts.length - 1] = { text: last.text + value }
    else parts.push({ text: value })
  }
  return { ...word, parts }
}

export function shellStatements(command: string): { statements: Statement[]; texts: string[] } | undefined {
  const lexed = lex(command.replace(HEREDOC, " $3"))
  const nodes = lexed && parse(lexed.tokens)
  if (!lexed || !nodes) return undefined
  return { statements: convert(nodes, new Map()), texts: lexed.texts }
}

export function opaque(statement: Statement): boolean {
  return statement.compound === "group" && statement.inner === undefined
}

export function executed(statements: readonly Statement[], index: number): boolean {
  for (let at = index; at >= 0; at--) {
    const prev = statements[at]?.prev
    if (prev === "or") return false
    if (prev !== "and") return true
  }
  return true
}

function convert(nodes: readonly Node[], known: Map<string, string>): Statement[] {
  const statements: Statement[] = []
  let prev: Link | undefined
  for (const node of nodes) {
    const values = node.binding ? new Map([...known, [node.binding.name, node.binding.value]]) : known
    const [first, ...rest] = node.stages.map((stage) => ({ words: stage.words.map((word) => substitute(word, values)), redirects: stage.redirects }))
    const words = first?.words ?? []
    const out = stdout(first?.redirects ?? [], rest.length ? "pipe" : "out")
    const shown = rest.length ? stdout(rest.at(-1)?.redirects ?? [], "out") : out
    const visible = shown === "out" || shown === "other"
    const plain = !node.compound && node.stages.every((stage) => stage.words.every((word) => literal(word) !== undefined) && stage.redirects.every(({ op, target }) => literal(target) !== undefined && (op === "<<<" || (!target.quoted && !/[{}]/.test(literal(target) ?? "")))))
    const writes = (first?.redirects ?? []).filter(({ fd, op }) => op === "&>" || op === "&>>" || (fd === 1 && /^>[>|]?$/.test(op))).map(({ target }) => pathText(substitute(target, values)))
    const errors = stderr(first?.redirects ?? [], rest.length ? "pipe" : "out")
    const inner = node.inner && convert(node.inner, new Map(values))
    statements.push({
      words, stages: rest.map((stage) => stage.words.map(literal)), out, visible, plain, link: node.link, prev, compound: node.compound, binding: node.binding, writes, errors,
      ...(inner ? { inner, subshell: node.subshell } : {}),
    })
    prev = node.link
    if (!node.compound && !node.binding && rest.length === 0 && words.length > 0 && words.every(assignment)) {
      for (const word of words) {
        const name = literalPrefix(word).split("=")[0] ?? ""
        const value = literal(word)
        if (value === undefined) known.delete(name)
        else known.set(name, value.slice(name.length + 1))
      }
    }
    else if (node.binding) for (const word of words) if (assignment(word)) known.delete(literalPrefix(word).split("=")[0] ?? "")
  }
  return statements
}

function stderr(redirects: readonly Redirect[], initial: Stream): Stream {
  let out = initial
  let err: Stream = "out"
  for (const { fd, op, target } of redirects) {
    const value = literal(target)
    if (op === "&>" || op === "&>>") out = err = "null"
    else if (fd === 1 && /^>[>|]?$/.test(op)) out = "null"
    else if (fd === 1 && op === ">&") out = value === "2" ? err : value === "1" ? out : "null"
    else if (fd === 2 && /^>[>|]?$/.test(op)) err = "null"
    else if (fd === 2 && op === ">&") err = value === "1" ? out : value === "2" ? err : "null"
  }
  return err
}

function stdout(redirects: readonly Redirect[], initial: Stream): Stream {
  let out = initial
  for (const { fd, op, target } of redirects) {
    if (op === "&>" || op === "&>>") out = "null"
    else if (fd === 1 && op === ">&") out = literal(target) === "-" ? "null" : literal(target) === "1" ? out : "other"
    else if (fd === 1 && /^>[>|]?$/.test(op)) out = "null"
  }
  return out
}

const RESERVED_NEXT = new Set(["do", "then", "else", "elif", "if", "while", "until", "!", "{", "time"])
const REDIRECT = /(\d*)(&>>|&>|>>|>&|>\||<<<|<<|<&|<>|>|<)/y
const OPERATOR = /&&|\|\||;;|\|&|[;\n&|()]/y
const PARAMETER = /[a-z_]\w*|[?#$!@*0-9-]/iy
const ESCAPE = /[0-7]{1,3}|x[\dA-Fa-f]{1,2}|u[\dA-Fa-f]{1,4}|U[\dA-Fa-f]{1,8}|c[\s\S]|[\s\S]/y

function sticky(pattern: RegExp, source: string, index: number): RegExpExecArray | null {
  pattern.lastIndex = index
  return pattern.exec(source)
}

function lex(source: string): { tokens: Token[]; texts: string[] } | undefined {
  const tokens: Token[] = []
  const texts: string[] = []
  let command = true
  let index = 0
  while (index < source.length) {
    const char = source[index] ?? ""
    if (char === " " || char === "\t" || char === "\r") {
      index++
      continue
    }
    if (char === "\\" && source[index + 1] === "\n") {
      index += 2
      continue
    }
    if (char === "#") {
      while (index < source.length && source[index] !== "\n") index++
      continue
    }
    const redirect = sticky(REDIRECT, source, index)
    if (redirect) {
      const [matched, digits = "", op = ""] = redirect
      if ((op === "<" || op === ">") && !digits && source[index + 1] === "(") {
        const end = closing(source, index + 1)
        if (end < 0) return undefined
        tokens.push({ type: "word", word: { parts: [{ name: "" }], opaque: true, quoted: false }, command })
        command = false
        index = end
        continue
      }
      if (op === "<<") return undefined
      index += matched.length
      while (source[index] === " " || source[index] === "\t") index++
      const target = readWord(source, index)
      if (!target || target.end === index) return undefined
      texts.push(target.word.parts.map((part) => "text" in part ? part.text : "").join(""))
      tokens.push({ type: "redirect", redirect: { fd: digits ? Number(digits) : op.startsWith("<") ? 0 : op.startsWith("&") ? -1 : 1, op, target: target.word } })
      index = target.end
      continue
    }
    const op = sticky(OPERATOR, source, index)?.[0]
    if (op) {
      tokens.push({ type: "op", op })
      command = true
      index += op.length
      continue
    }
    const read = readWord(source, index)
    if (!read || read.end === index) return undefined
    texts.push(read.word.parts.map((part) => "text" in part ? part.text : "").join(""))
    tokens.push({ type: "word", word: read.word, command })
    command = command && (assignment(read.word) || (!read.word.quoted && RESERVED_NEXT.has(literal(read.word) ?? "")))
    index = read.end
  }
  return { tokens, texts }
}

function readWord(source: string, start: number): { word: Word; end: number } | undefined {
  const parts: Part[] = []
  let opaque = false
  let quoted = false
  let index = start
  const add = (value: string) => {
    const last = parts.at(-1)
    if (last && "text" in last) parts[parts.length - 1] = { text: last.text + value }
    else parts.push({ text: value })
  }
  const expand = () => {
    if (source[index] === "`") {
      let end = index + 1
      while (end < source.length && source[end] !== "`") end += source[end] === "\\" ? 2 : 1
      if (end >= source.length) return false
      parts.push({ name: "" })
      opaque = true
      index = end + 1
      return true
    }
    const next = source[index + 1]
    if (next === "(" || next === "{") {
      const end = closing(source, index + 1, next, next === "(" ? ")" : "}")
      if (end < 0) return false
      const inner = source.slice(index + 2, end - 1)
      if (next === "{" && /^[a-z_]\w*$/i.test(inner)) parts.push({ name: inner })
      else {
        parts.push({ name: "" })
        opaque = true
      }
      index = end
      return true
    }
    const name = sticky(PARAMETER, source, index + 1)?.[0]
    if (name) {
      parts.push({ name })
      index += 1 + name.length
    }
    else {
      add("$")
      index++
    }
    return true
  }
  while (index < source.length) {
    const char = source[index] ?? ""
    if (/[\s;&|()<>]/.test(char)) break
    quoted ||= char === "\\" || char === "'" || char === '"'
    if (char === "\\") {
      const next = source[index + 1]
      if (next === undefined) return undefined
      if (next !== "\n") add(next)
      index += 2
    }
    else if (char === "'") {
      const end = source.indexOf("'", index + 1)
      if (end < 0) return undefined
      add(source.slice(index + 1, end))
      index = end + 1
    }
    else if (char === "$" && source[index + 1] === "'") {
      const decoded = ansi(source, index + 2)
      if (!decoded) return undefined
      add(decoded.text)
      quoted = true
      index = decoded.end
    }
    else if (char === '"' || (char === "$" && source[index + 1] === '"')) {
      index += char === "$" ? 2 : 1
      quoted = true
      while (source[index] !== '"') {
        const inner = source[index]
        if (inner === undefined) return undefined
        if (inner === "\\" && /[$`"\\\n]/.test(source[index + 1] ?? "")) {
          if (source[index + 1] !== "\n") add(source[index + 1] ?? "")
          index += 2
        }
        else if (inner === "$" || inner === "`") {
          if (!expand()) return undefined
        }
        else {
          add(inner)
          index++
        }
      }
      index++
    }
    else if (char === "$" || char === "`") {
      if (!expand()) return undefined
    }
    else {
      add(char)
      index++
    }
  }
  return { word: { parts, opaque, quoted }, end: index }
}

function ansi(source: string, start: number): { text: string; end: number } | undefined {
  const simple: Record<string, string> = { a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" }
  let text = ""
  for (let index = start; index < source.length; index++) {
    const char = source[index] ?? ""
    if (char === "'") return { text, end: index + 1 }
    if (char !== "\\") {
      text += char
      continue
    }
    const escape = sticky(ESCAPE, source, index + 1)?.[0]
    if (!escape) return undefined
    index += escape.length
    const code = /^[0-7]/.test(escape) ? parseInt(escape, 8) : /^[xuU][\dA-Fa-f]/.test(escape) ? parseInt(escape.slice(1), 16) : undefined
    if (code !== undefined) text += code <= 0x10ffff ? String.fromCodePoint(code) : ""
    else if (escape[0] === "c" && escape.length === 2) text += String.fromCharCode(escape.charCodeAt(1) & 31)
    else text += simple[escape] ?? (/^['"\\?]$/.test(escape) ? escape : `\\${escape}`)
  }
  return undefined
}

function closing(source: string, start: number, open = "(", close = ")"): number {
  let depth = 0
  for (let index = start; index < source.length; index++) {
    const char = source[index]
    if (char === "\\") index++
    else if (char === "'") {
      index = source.indexOf("'", index + 1)
      if (index < 0) return -1
    }
    else if (char === '"') {
      index++
      while (index < source.length && source[index] !== '"') index += source[index] === "\\" ? 2 : 1
      if (index >= source.length) return -1
    }
    else if (char === open) depth++
    else if (char === close && --depth === 0) return index + 1
  }
  return -1
}

function parse(tokens: readonly Token[]): Node[] | undefined {
  let at = 0
  const isWord = (value: string) => {
    const token = tokens[at]
    return token?.type === "word" && !token.word.quoted && literal(token.word) === value
  }
  const isOp = (...values: string[]) => {
    const token = tokens[at]
    return token?.type === "op" && values.includes(token.op)
  }
  const wordAt = (index: number) => {
    const token = tokens[index]
    return token?.type === "word" ? token.word : undefined
  }
  const closer = (until: ReadonlySet<string>) => {
    const token = tokens[at]
    return (token?.type === "word" && token.command && !token.word.quoted && until.has(literal(token.word) ?? "")) || (until.has(")") && isOp(")"))
  }
  type Element = { stage: Stage; compound?: "group" | "function"; inner?: Node[]; subshell?: boolean }
  const trailing = <Kind extends "group" | "function">(compound: Kind, base: Stage = { words: [], redirects: [] }): { stage: Stage; compound: Kind } => {
    const stage = { words: base.words, redirects: [...base.redirects] }
    for (let token = tokens[at]; token?.type === "redirect"; token = tokens[++at]) stage.redirects.push(token.redirect)
    return { stage, compound }
  }
  const links: Record<string, Link> = { "&&": "and", "||": "or", "&": "background", ";": "then", "\n": "then", ";;": "then" }

  function list(until: ReadonlySet<string>): Node[] | undefined {
    const nodes: Node[] = []
    while (at < tokens.length) {
      if (isOp(";", "\n")) {
        at++
        continue
      }
      if (closer(until)) return nodes
      const pipeline = pipe()
      if (!pipeline) return undefined
      const token = tokens[at]
      let link: Link = "end"
      if (token?.type === "op" && token.op !== ")") {
        const value = links[token.op]
        if (!value) return undefined
        link = value
        at++
      }
      else if (token && !closer(until)) return undefined
      const last = pipeline.at(-1)
      if (last) last.link = link
      nodes.push(...pipeline)
    }
    return until.size ? undefined : nodes
  }

  function pipe(): Node[] | undefined {
    const stages: Stage[] = []
    let compound: Node["compound"]
    let unrolled: Node[] | undefined
    let inner: Node[] | undefined
    let subshell = false
    for (;;) {
      const element = command()
      if (!element) return undefined
      if ("nodes" in element) unrolled = element.nodes
      else {
        stages.push(element.stage)
        compound ??= element.compound
        if (element.inner) inner = [...(inner ?? []), ...element.inner]
        subshell ||= element.subshell ?? false
      }
      if (!isOp("|", "|&")) break
      if (isOp("|&")) stages.at(-1)?.redirects.push({ fd: 2, op: ">&", target: { parts: [{ text: "1" }], opaque: false, quoted: false } })
      at++
      while (isOp("\n")) at++
    }
    if (unrolled && !stages.length) return unrolled
    const group = !unrolled && inner ? { inner, subshell: subshell || stages.length > 1 } : {}
    return [{ stages: unrolled ? [{ words: [], redirects: [] }, ...stages] : stages, link: "end", compound: unrolled ? "group" : compound, ...group }]
  }

  function command(): Element | { nodes: Node[] } | undefined {
    const token = tokens[at]
    if (token?.type === "op" && token.op === "(") {
      at++
      const inner = list(new Set([")"]))
      if (!inner || !isOp(")")) return undefined
      at++
      return { ...trailing("group"), inner, subshell: true }
    }
    const name = token?.type === "word" && token.command && !token.word.quoted ? literal(token.word) : undefined
    if (name === "for") return loop()
    if (name === "case") {
      for (let depth = 0; at < tokens.length; at++) {
        if (isWord("case")) depth++
        if (isWord("esac") && --depth === 0) {
          at++
          return trailing("group")
        }
      }
      return undefined
    }
    if (name === "if" || name === "while" || name === "until" || name === "select" || name === "{") {
      const end = name === "if" ? "fi" : name === "{" ? "}" : "done"
      at++
      const inner = list(new Set([end]))
      if (!inner || !isWord(end)) return undefined
      at++
      return name === "{" ? { ...trailing("group"), inner } : trailing("group")
    }
    if (name === "function") {
      at += 2
      if (isOp("(")) {
        at++
        if (!isOp(")")) return undefined
        at++
      }
      return body()
    }
    if (name === "[[") {
      const start = wordAt(at)
      while (at < tokens.length && !isWord("]]")) at++
      if (!start || at >= tokens.length) return undefined
      at++
      return { stage: trailing("group", { words: [start], redirects: [] }).stage }
    }
    const stage: Stage = { words: [], redirects: [] }
    for (let item = tokens[at]; item && item.type !== "op"; item = tokens[++at]) {
      if (item.type === "redirect") stage.redirects.push(item.redirect)
      else stage.words.push(item.word)
    }
    if (stage.words.length === 1 && isOp("(")) {
      at++
      if (!isOp(")")) return undefined
      at++
      return body()
    }
    return stage.words.length || stage.redirects.length ? { stage } : undefined
  }

  function body(): { stage: Stage; compound: "function" } | undefined {
    while (isOp("\n")) at++
    const element = command()
    return element && !("nodes" in element) ? trailing("function", element.stage) : undefined
  }

  function loop(): { nodes: Node[] } | { stage: Stage; compound: "group" } | undefined {
    at++
    const variable = wordAt(at)
    const name = variable && !variable.quoted ? literal(variable) : undefined
    if (!name || !/^[a-z_]\w*$/i.test(name)) return undefined
    at++
    const values: (string | undefined)[] = []
    const listed = isWord("in")
    if (listed) for (let word = wordAt(++at); word; word = wordAt(++at)) values.push(literal(word))
    while (isOp(";", "\n")) at++
    if (!isWord("do")) return undefined
    at++
    const inner = list(new Set(["done"]))
    if (!inner || !isWord("done")) return undefined
    at++
    if (tokens[at]?.type === "redirect" || isOp("|", "|&") || !listed || !values.length || inner.some((node) => node.compound || node.binding || node.link === "background")) return trailing("group")
    const nodes: Node[] = []
    for (const value of values) {
      if (value === undefined) return trailing("group")
      inner.forEach((node, index) => nodes.push({
        ...node,
        stages: node.stages.map((stage) => ({ words: stage.words.map((word) => substitute(word, new Map([[name, value]]))), redirects: stage.redirects })),
        binding: { name, value },
        link: index === inner.length - 1 ? "then" : node.link,
      }))
    }
    return { nodes }
  }

  return list(new Set())
}

const SHELL_CONTROL = new Set(["exit", "exec", "return", "logout", "trap", "eval", "source", ".", "alias", "shopt", "enable", "builtin", "command", "kill", "set", "hash"])
const SHELL_ENVIRONMENT = /^(?:PATH|BASH_ENV|ENV|SHELLOPTS|BASHOPTS)=/
const DECLARE = new Set(["export", "declare", "typeset", "local", "readonly", "env"])

export function controls(statement: Statement): boolean {
  if (statement.compound) return true
  const index = commandIndex(statement)
  if (index < 0) return false
  const name = literal(statement.words[index])
  return name === undefined || SHELL_CONTROL.has(name)
}

export function overrides(statement: Statement): boolean {
  if (statement.compound === "function") return true
  const index = commandIndex(statement)
  const name = index < 0 ? undefined : literal(statement.words[index])
  if (name === "alias" || name === "hash" || name === "enable") return true
  const declared = name !== undefined && DECLARE.has(name.split("/").at(-1) ?? "")
  return statement.words.some((word, at) => (at < (index < 0 ? statement.words.length : index) || (declared && at > index)) && SHELL_ENVIRONMENT.test(literalPrefix(word)))
}

const REPLAY = new Set(["cat", "tac", "less", "more", "bat", "head", "tail", "sed", "awk", "gawk", "perl", "ruby", "python", "python3", "node", "bun", "bunx", "deno", "npx", "php", "sh", "bash", "zsh", "fish", "dash", "ksh", "eval", "source", ".", "exec", "command", "builtin", "env", "xargs", "sudo", "time", "nohup", "timeout", "watch", "nice", "script", "tee", "printf", "opencode", "sqlite3", "jq", "yq", "diff", "xxd", "od", "strings", "column", "nl", "fold", "paste", "tr", "cut", "sort", "uniq", "fmt", "rev", "base64", "curl", "wget", "osascript", "pbpaste", "trap", "zcat", "gzcat"])
type Filter = { operands: number; flags: string; values: string; switches?: readonly string[]; options?: readonly string[]; pattern?: true; counts?: true; any?: true }

const GREP: Filter = {
  operands: 1, pattern: true, flags: "ivwxcnhHoqsEFGPaIUzbL", values: "efABCm",
  switches: ["ignore-case", "invert-match", "word-regexp", "line-regexp", "count", "line-number", "only-matching", "quiet", "silent", "extended-regexp", "fixed-strings", "basic-regexp", "perl-regexp", "text", "no-messages", "color", "colour", "null-data", "no-filename", "with-filename"],
  options: ["regexp", "file", "after-context", "before-context", "context", "max-count"],
}
const COUNTS: Filter = { operands: 0, counts: true, flags: "qv", values: "nc", options: ["lines", "bytes"], switches: ["quiet", "silent"] }
const FILTERS: Readonly<Record<string, Filter>> = {
  head: COUNTS,
  tail: COUNTS,
  grep: GREP,
  egrep: GREP,
  fgrep: GREP,
  wc: { operands: Infinity, flags: "", values: "", any: true },
  tee: { operands: Infinity, flags: "", values: "", any: true },
  cut: { operands: 0, flags: "snz", values: "dfcb", options: ["delimiter", "fields", "characters", "bytes", "output-delimiter"], switches: ["complement", "only-delimited"] },
  sort: { operands: 0, flags: "rnufbdghiMRVsz", values: "kt", options: ["key", "field-separator"], switches: ["reverse", "numeric-sort", "unique", "ignore-case", "general-numeric-sort", "human-numeric-sort", "version-sort", "stable"] },
  uniq: { operands: 0, flags: "cduiDz", values: "fsw", options: ["skip-fields", "skip-chars", "check-chars"], switches: ["count", "repeated", "unique", "ignore-case"] },
  jq: { operands: 1, flags: "rjcnseaSCMR", values: "", options: ["arg", "argjson", "indent"], switches: ["raw-output", "join-output", "compact-output", "null-input", "slurp", "exit-status", "ascii-output", "sort-keys", "tab", "raw-input", "color-output", "monochrome-output", "seq", "stream"] },
  tr: { operands: 2, flags: "dscC", values: "" },
  column: { operands: 0, flags: "tx", values: "sco", options: ["separator", "output-separator"], switches: ["table"] },
  cat: { operands: 0, flags: "nbsvetuAET", values: "" },
}

export function pureFilter(stage: readonly (string | undefined)[]): boolean {
  const name = stage[0]?.split("/").at(-1) ?? ""
  const filter = FILTERS[name]
  const args = stage.slice(1)
  if (!filter || !args.every((arg): arg is string => arg !== undefined)) return false
  if (filter.any) return true
  let positional = 0
  let patterns = false
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? ""
    if (arg === "--") {
      positional += args.length - index - 1
      break
    }
    if (filter.counts && /^[+-]\d+$/.test(arg)) continue
    if (arg === "-" || !arg.startsWith("-")) {
      if (arg !== "-") positional++
      continue
    }
    if (arg.startsWith("--")) {
      const [option = "", value] = arg.slice(2).split(/=(.*)/s)
      if (filter.switches?.includes(option)) continue
      if (!filter.options?.includes(option)) return false
      if (filter.pattern && (option === "regexp" || option === "file")) patterns = true
      if (value === undefined) index += name === "jq" && option !== "indent" ? 2 : 1
      continue
    }
    for (let at = 1; at < arg.length; at++) {
      const flag = arg[at] ?? ""
      if (filter.flags.includes(flag)) continue
      if (!filter.values.includes(flag)) return false
      if (filter.pattern && (flag === "e" || flag === "f")) patterns = true
      if (at === arg.length - 1) index++
      break
    }
  }
  return positional <= (patterns ? 0 : filter.operands)
}

export function replays(statement: Statement, special?: (command: string, args: readonly (string | undefined)[]) => boolean | undefined): boolean {
  if (!statement.visible) return false
  if (statement.compound) return true
  if (!statement.stages.every(pureFilter)) return true
  let index = commandIndex(statement)
  if (index < 0) return false
  if (literal(statement.words[index]) === "snip") index++
  const name = literal(statement.words[index])
  if (name === undefined) return true
  const args = statement.words.slice(index + 1).map(literal)
  const command = name.split("/").at(-1) ?? ""
  if (command === "echo") return name !== "echo" || echoText(statement) === undefined
  const custom = special?.(command, args)
  if (custom !== undefined) return custom
  if (/^(?:grep|egrep|fgrep|rg)$/.test(command)) return !quietGrep(args)
  if (command === "git") return gitReplays(args)
  if (command === "gh") return args.some((arg) => arg === undefined || /^(?:view|api|diff|run)$/.test(arg))
  return REPLAY.has(command)
}

function quietGrep(args: readonly (string | undefined)[]): boolean {
  const words = args.filter((arg): arg is string => arg !== undefined)
  if (words.length !== args.length) return false
  const flags = words.filter((arg) => arg.startsWith("-"))
  const letters = flags.filter((flag) => !flag.startsWith("--")).join("")
  const long = flags.filter((flag) => flag.startsWith("--"))
  if (/[lLcqn]/.test(letters) || long.some((flag) => /^--(?:files-with(?:out)?-match(?:es)?|count|quiet|silent|line-number)$/.test(flag))) return true
  if (/[vABCef]/.test(letters) || long.length) return false
  return /\s/.test(words.find((arg) => !arg.startsWith("-")) ?? "")
}

function gitReplays(args: readonly (string | undefined)[]): boolean {
  let index = 0
  while (index < args.length && (args[index]?.startsWith("-") ?? false)) index += args[index] === "-C" || args[index] === "-c" ? 2 : 1
  const command = args[index]
  if (command === undefined) return true
  if (command === "log") return !args.includes("--oneline")
  return /^(?:show|diff|grep|blame|cat-file|notes|format-patch|reflog|whatchanged)$/.test(command)
}

export function echoOutline(statement: Statement): boolean {
  if (statement.compound || statement.stages.length || literal(statement.words[0]) !== "echo") return false
  const text = statement.words.slice(1).flatMap((word) => word.parts.map((part) => "text" in part ? part.text : part.name === "" || part.name === "?" ? "0" : "\n")).join(" ")
  return /^[\p{L}\p{N} .,!?=#+@_-]*$/u.test(text)
}

export function echoText(statement: Statement): string | undefined {
  if (statement.compound || statement.stages.length || literal(statement.words[0]) !== "echo") return undefined
  const args = statement.words.slice(literal(statement.words[1]) === "-n" ? 2 : 1)
  const rendered: string[] = []
  for (const word of args) {
    if (word.opaque) return undefined
    let value = ""
    for (const part of word.parts) {
      if ("text" in part) value += part.text
      else if (part.name === "?") value += "0"
      else return undefined
    }
    rendered.push(value)
  }
  const text = rendered.join(" ")
  return /^[\p{L}\p{N} .,!?=#+@_-]*$/u.test(text) ? text : undefined
}
