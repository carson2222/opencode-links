import type { Links } from "./links.ts"

const TICK = 10_000
const MIN_DELAY = 500

export function createWatch(links: Links, input: {
  root: () => string
  focused: () => boolean
}) {
  let mounted = true
  let network = new AbortController()
  let needsCatchUp = true
  let scanned = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let entered: number | undefined

  const live = () => mounted && input.focused()

  const run = (entry: boolean) => {
    if (!live()) return
    clearTimeout(timer)
    timer = undefined
    if (network.signal.aborted) network = new AbortController()
    const rootID = input.root()
    if (entry) {
      entered = Date.now()
      links.enter(rootID)
    }
    const signal = network.signal
    const options = { scope: rootID, entered }
    void Promise.allSettled([
      links.tracker.refresh(links.pulls(rootID), signal, options),
      links.tracker.check(links.pages(rootID).map((page) => page.origin), signal),
      links.issues?.refresh(links.allIssues(rootID), signal, options),
    ]).then(() => { if (!signal.aborted) schedule() })
  }

  const schedule = () => {
    if (!live()) return
    clearTimeout(timer)
    const rootID = input.root()
    const now = Date.now()
    const due = Math.min(
      links.tracker.due(links.pulls(rootID), entered),
      links.tracker.probeDue(links.pages(rootID).map((page) => page.origin)),
      links.issues?.due(links.allIssues(rootID), entered) ?? Number.POSITIVE_INFINITY,
    )
    timer = setTimeout(tick, Math.min(TICK, Math.max(MIN_DELAY, due - now + 5)))
  }

  const tick = () => {
    timer = undefined
    if (!live()) return
    if ((needsCatchUp || links.tracker.pending(input.root())) && Date.now() - scanned >= TICK) catchUp(false)
    else run(false)
  }

  const pause = () => {
    network.abort()
    clearTimeout(timer)
    timer = undefined
  }

  const catchUp = (entry: boolean) => {
    if (!live()) { needsCatchUp = true; return }
    if (network.signal.aborted) network = new AbortController()
    const started = Date.now()
    scanned = started
    needsCatchUp = false
    run(entry)
    void links.tracker.scan(input.root(), network.signal).then((success) => {
      if (!mounted || scanned !== started) return
      needsCatchUp = !success
      run(false)
    })
  }

  catchUp(true)
  const stops = [
    links.host.on("server.connected", () => catchUp(true)),
    links.tracker.subscribe(schedule),
    links.issues?.subscribe(schedule) ?? (() => undefined),
  ]

  return {
    update: () => run(false),
    focus: () => needsCatchUp ? catchUp(true) : run(true),
    enter: () => run(true),
    blur: pause,
    rootChanged() {
      pause()
      needsCatchUp = true
      catchUp(true)
    },
    dispose() {
      mounted = false
      pause()
      stops.forEach((stop) => stop())
    },
  }
}

export type Watch = ReturnType<typeof createWatch>
