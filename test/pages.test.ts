import { describe, expect, test } from "bun:test"
import { mergePages, pagesIn, probe, probeNode } from "../src/pages.ts"

const urls = (text: string) => pagesIn(text, 0).map((page) => page.url)

describe("pagesIn", () => {
  test("reads bare, backticked and markdown links", () => {
    expect(urls("Open https://web-1991.shop.localhost/catalog/12.")).toEqual(["https://web-1991.shop.localhost/catalog/12"])
    expect(urls("Running at `http://localhost:3000/`")).toEqual(["http://localhost:3000"])
    expect(urls("[Library](https://shop.localhost/library)")).toEqual(["https://shop.localhost/library"])
    expect(urls("(see http://127.0.0.1:62708/index.html)")).toEqual(["http://127.0.0.1:62708/index.html"])
  })

  test("drops markdown emphasis around links", () => {
    expect(urls("The sample site ...\n\n**https://web-2194-toolbar-icons.shop.localhost**\n\nIt displays...")).toEqual([
      "https://web-2194-toolbar-icons.shop.localhost",
    ])
    expect(urls("**http://localhost:3194/lab/glyphs**")).toEqual(["http://localhost:3194/lab/glyphs"])
    expect(urls("*http://localhost:3000/a*, _http://localhost:3001/b_ and ~~http://localhost:3002/c~~.")).toEqual([
      "http://localhost:3000/a",
      "http://localhost:3001/b",
      "http://localhost:3002/c",
    ])
    expect(urls("***http://localhost:3000/x***")).toEqual(["http://localhost:3000/x"])
    expect(urls("_**http://localhost:3000/x**_")).toEqual(["http://localhost:3000/x"])
    expect(urls("**Open http://localhost:3000/x?tab=1#top**")).toEqual(["http://localhost:3000/x?tab=1#top"])
    expect(urls("**Open http://localhost:3000/x?q=*foo***")).toEqual(["http://localhost:3000/x?q=*foo*"])
    expect(urls("(**http://localhost:3000/x**)")).toEqual(["http://localhost:3000/x"])
    expect(urls("xhttp://localhost:3000 and https://*.shop.localhost**")).toEqual([])
  })

  test("keeps emphasis characters that belong to the url", () => {
    expect(urls("http://localhost:3000/a_b/c*d/~e")).toEqual(["http://localhost:3000/a_b/c*d/~e"])
    expect(urls("http://localhost:3000/draft_ and http://localhost:3000/v~")).toEqual([
      "http://localhost:3000/draft_",
      "http://localhost:3000/v~",
    ])
    expect(urls("snake_case at http://localhost:3000/tmp_")).toEqual(["http://localhost:3000/tmp_"])
    expect(urls("**http://localhost:3000/tmp_**")).toEqual(["http://localhost:3000/tmp_"])
    expect(urls("`http://localhost:3000/x?q=a_b*c~d`")).toEqual(["http://localhost:3000/x?q=a_b*c~d"])
    expect(urls("http://localhost:3000/api?filter[status]=open")).toEqual(["http://localhost:3000/api?filter[status]=open"])
  })

  test("only strips delimiters that close a still open run", () => {
    expect(urls("**Done**. Open http://localhost:3000/search?q=foo**")).toEqual(["http://localhost:3000/search?q=foo**"])
    expect(urls("`*` Open http://localhost:3000/a*")).toEqual(["http://localhost:3000/a*"])
    expect(urls("_a_ and don't stop http://localhost:3000/b_")).toEqual(["http://localhost:3000/b_"])
    expect(urls("`**http://localhost:3000/a**`")).toEqual(["http://localhost:3000/a**"])
    expect(urls("*http://localhost:3000/a*, then http://localhost:3000/b*")).toEqual(["http://localhost:3000/a", "http://localhost:3000/b*"])
    expect(urls("[x](http://localhost:3000/a_) http://localhost:3000/b_")).toEqual(["http://localhost:3000/a_", "http://localhost:3000/b_"])
  })

  test("still strips runs left open around code and earlier text", () => {
    expect(urls("a ` stray **http://localhost:3000/x**")).toEqual(["http://localhost:3000/x"])
    expect(urls("``a`b`` then **http://localhost:3000/x**")).toEqual(["http://localhost:3000/x"])
    expect(urls("**Done** and **see http://localhost:3000/x**")).toEqual(["http://localhost:3000/x"])
    expect(urls("**http://localhost:3000/a** **http://localhost:3000/b**")).toEqual(["http://localhost:3000/a", "http://localhost:3000/b"])
    expect(urls("**http://localhost:3000/a****")).toEqual(["http://localhost:3000/a**"])
  })

  test("reads link text, targets, brackets and titles", () => {
    expect(urls("[http://localhost:3000/a](http://localhost:3000/a)")).toEqual(["http://localhost:3000/a"])
    expect(urls("[http://localhost:3000](http://localhost:4000/b)")).toEqual(["http://localhost:3000", "http://localhost:4000/b"])
    expect(urls("**[Glyphs](http://localhost:3194/lab/glyphs)**")).toEqual(["http://localhost:3194/lab/glyphs"])
    expect(urls("[**http://localhost:3000/a**](http://localhost:3000/a)")).toEqual(["http://localhost:3000/a"])
    expect(urls('[Lab](http://localhost:3194/lab "Lab page")')).toEqual(["http://localhost:3194/lab"])
    expect(urls("see [http://localhost:3000/a].")).toEqual(["http://localhost:3000/a"])
    expect(urls("[x](http://localhost:3000/wiki/A_(b))")).toEqual(["http://localhost:3000/wiki/A_(b)"])
  })

  test("splits on ]( only inside link text", () => {
    expect(urls("http://localhost:3000/a](b)")).toEqual(["http://localhost:3000/a](b)"])
    expect(urls("[x] see http://localhost:3000/a](b)")).toEqual(["http://localhost:3000/a](b)"])
    expect(urls("**http://localhost:3000/a](b)** then http://localhost:3000/c*")).toEqual([
      "http://localhost:3000/a](b)",
      "http://localhost:3000/c*",
    ])
    expect(pagesIn("http://localhost:3000/a](b)", 0)[0]?.aliases).toBeUndefined()
  })

  test("keeps queries and fragments, normalizes host and root", () => {
    expect(urls("http://LOCALHOST:5173/?tab=files#top and http://[::1]:8000")).toEqual([
      "http://localhost:5173/?tab=files#top",
      "http://[::1]:8000",
    ])
    expect(urls("https://shop.localhost:443/")).toEqual(["https://shop.localhost"])
  })

  test("ignores templates, wildcards and non local hosts", () => {
    expect(urls("use http://localhost:<port> or https://*.shop.localhost or http://localhost:${PORT}")).toEqual([])
    expect(urls("https://example.com http://192.168.1.4:3000 https://app.vercel.app")).toEqual([])
    expect(urls("http://notlocalhost.com")).toEqual([])
    expect(urls("https://localhost.example.com/page and http://localhost:3000bad/path")).toEqual([])
    expect(urls("http://127.0.0.1.evil.com:3000")).toEqual([])
  })

  test("dedupes within a message", () => {
    expect(urls("http://localhost:3000 and again http://localhost:3000/")).toEqual(["http://localhost:3000"])
  })

  test("labels drop the scheme and group by origin", () => {
    const [page] = pagesIn("https://shop.localhost/catalog/1", 5)
    expect(page).toEqual({
      url: "https://shop.localhost/catalog/1",
      origin: "https://shop.localhost",
      label: "shop.localhost/catalog/1",
      created: 5,
    })
  })
})

describe("legacy aliases", () => {
  const aliases = (text: string) => pagesIn(text, 0).map((page) => [page.url, page.aliases ?? []])

  test("records the key the old parser stored for the same source", () => {
    expect(aliases("**http://localhost:3194/lab/glyphs**")).toEqual([
      ["http://localhost:3194/lab/glyphs", ["http://localhost:3194/lab/glyphs**"]],
    ])
    expect(aliases("_**http://localhost:3000/x**_.")).toEqual([["http://localhost:3000/x", ["http://localhost:3000/x**_"]]])
    expect(aliases("**http://localhost:3000/tmp_**")).toEqual([["http://localhost:3000/tmp_", ["http://localhost:3000/tmp_**"]]])
  })

  test("adds none when the old parser stored nothing or the same url", () => {
    expect(aliases("**https://web-2194-toolbar-icons.shop.localhost**")).toEqual([["https://web-2194-toolbar-icons.shop.localhost", []]])
    expect(aliases("_http://localhost:3001/b_")).toEqual([["http://localhost:3001/b", []]])
    expect(aliases("http://localhost:3000/a* and http://localhost:3000/b_ and **http://localhost:3000/c")).toEqual([
      ["http://localhost:3000/a*", []],
      ["http://localhost:3000/b_", []],
      ["http://localhost:3000/c", []],
    ])
    expect(aliases("[http://localhost:3000](http://localhost:4000/b**)")).toEqual([
      ["http://localhost:3000", []],
      ["http://localhost:4000/b**", []],
    ])
    expect(aliases("**Done**. Open http://localhost:3000/search?q=foo** and `*` http://localhost:3000/a*")).toEqual([
      ["http://localhost:3000/search?q=foo**", []],
      ["http://localhost:3000/a*", []],
    ])
    expect("aliases" in (pagesIn("http://localhost:3000", 0)[0] ?? {})).toBe(false)
  })

  test("a message keeps aliases when the plain url is repeated", () => {
    expect(aliases("**http://localhost:3194/lab/glyphs** then http://localhost:3194/lab/glyphs")).toEqual([
      ["http://localhost:3194/lab/glyphs", ["http://localhost:3194/lab/glyphs**"]],
    ])
  })
})

describe("mergePages", () => {
  const stored = (url: string, created: number) => ({ url, origin: new URL(url).origin, label: url.replace(/^https?:\/\//, ""), created })

  test("a proven alias replaces the old malformed row and keeps its key", () => {
    const old = stored("http://localhost:3194/lab/glyphs**", 1)
    const other = stored("http://localhost:4000", 2)
    const found = pagesIn("**http://localhost:3194/lab/glyphs**", 1)
    expect(mergePages([old, other], found)).toEqual([
      other,
      { ...stored("http://localhost:3194/lab/glyphs", 1), aliases: ["http://localhost:3194/lab/glyphs**"] },
    ])
  })

  test("newer plain mentions keep earlier aliases", () => {
    const first = mergePages([], pagesIn("**http://localhost:3194/lab/glyphs**", 1))
    const later = mergePages(first, pagesIn("http://localhost:3194/lab/glyphs", 5))
    expect(later).toEqual([{ ...stored("http://localhost:3194/lab/glyphs", 5), aliases: ["http://localhost:3194/lab/glyphs**"] }])
  })

  test("literal suffix rows are never collapsed without proof", () => {
    const literal = stored("http://localhost:3000/a*", 1)
    expect(mergePages([literal], pagesIn("http://localhost:3000/a", 2))).toEqual([literal, stored("http://localhost:3000/a", 2)])
  })

  test("a repeated link moves to its newest mention", () => {
    const [old] = pagesIn("http://localhost:3000", 1)
    const [other] = pagesIn("http://localhost:4000", 2)
    const [again] = pagesIn("http://localhost:3000", 3)
    if (!old || !other || !again) throw new Error("fixture")
    expect(mergePages([old, other], [again])).toEqual([again, other])
  })
})

test.each([["fetch", probe], ["node", probeNode]] as const)("plain localhost replies stay live while proxy failures are dimmed (%s)", async (_name, probe) => {
  let response = { status: 404, headers: {} }
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(null, response) })
  const signal = new AbortController().signal
  const origin = server.url.origin
  try {
    expect(await probe(origin, signal)).toBe("up")
    response = { status: 500, headers: {} }
    expect(await probe(origin, signal)).toBe("up")
    response = { status: 404, headers: { "x-portless": "1" } }
    expect(await probe(origin, signal)).toBe("down")
    response = { status: 502, headers: {} }
    expect(await probe(origin, signal)).toBe("down")
  } finally { server.stop(true) }
  expect(await probe(origin, signal)).toBe("down")
})
