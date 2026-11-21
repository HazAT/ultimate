// Measure what each server event costs a page: time until the next task and DOM mutations in the transcript in that
// window. Watches an open conversation, or sends one prompt and waits.
// Usage: node renders.ts <url> <id> [--seconds 45] [--send "prompt"] [--profile out.cpuprofile]
// With --send the page needs `window.ultimate` (web/src/sdk/test-hook.ts); it measures until that turn is idle.
import { writeFileSync } from 'node:fs'
import { chromium } from 'playwright-core'
import { browserBinary } from '../../../extensions/browser/server.ts'

const args = process.argv.slice(2)
const [base, id] = args
const flag = (name: string) => {
  const index = args.indexOf(name)
  return index < 0 ? undefined : args[index + 1]
}
if (!base || !id)
  throw new Error('Usage: node renders.ts <url> <id> [--seconds 45] [--send "prompt"]')
const seconds = Number(flag('--seconds') ?? 45)
const prompt = flag('--send')
const profile = flag('--profile')

const browser = await chromium.launch({ executablePath: await browserBinary() })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
await page.addInitScript(() => {
  sessionStorage.setItem('ultimate.driven', '1')
  const w = window as unknown as Record<string, unknown>
  type Measured = {
    ev: string
    task: number
    mutations: number
  }
  const events: Measured[] = []
  let on = false
  // DOM mutation records in the transcript count toward the event whose window is open: from its dispatch until its
  // next task, the same window as its task time. Writes after that window (a later timer, an animation) count for no
  // event. One observer watches the app, so every transcript counts, side chats and freshly mounted ones included. A
  // record counts when its target is inside a transcript, or inside a subtree a counted record of the same batch
  // removed (newest first, so an ancestor's removal is seen before the writes inside it). A node moved in and out of a
  // transcript within one batch can count a write made outside it; the transcript never does that.
  const transcript = '[data-ui="transcript"]'
  const inTranscript = (records: MutationRecord[]) => {
    const removed = new Set<Node>()
    const counts = (record: MutationRecord) => {
      for (let node: Node | null = record.target; node; node = node.parentNode)
        if ((node instanceof Element && node.matches(transcript)) || removed.has(node)) return true
      return false
    }
    let count = 0
    for (const record of records.toReversed())
      if (counts(record)) {
        count++
        for (const node of record.removedNodes) removed.add(node)
      }
    return count
  }
  let mutating: Measured | undefined
  const mutations = new MutationObserver((records) => {
    if (mutating) mutating.mutations += inTranscript(records)
  })
  const drain = () => {
    const records = inTranscript(mutations.takeRecords())
    if (mutating) mutating.mutations += records
  }
  w.renders = {
    events,
    start: () => {
      mutations.observe(document.getElementById('app')!, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      })
      on = true
    },
  }
  // Solid applies a store change synchronously or in a microtask, so the time until the next task covers the handler and
  // its DOM writes, plus any task already queued ahead of it: latency, not the event's own cost alone.
  const channel = new MessageChannel()
  const waiting: (() => void)[] = []
  channel.port1.addEventListener('message', () => waiting.shift()?.())
  channel.port1.start()
  const afterNextTask = (then: () => void) => {
    waiting.push(then)
    channel.port2.postMessage(0)
  }
  // Listeners run in the order they were added, so these run before the store's and start each event's clock.
  const Native = window.EventSource
  window.EventSource = class extends Native {
    constructor(url: string | URL, init?: EventSourceInit) {
      super(url, init)
      for (const name of ['view', 'ops', 'doc', 'docOps', 'conversations', 'tasks', 'ui', 'uiOps'])
        super.addEventListener(name, (event) => {
          const started = performance.now()
          const data = (event as MessageEvent<string>).data
          const kind = /"kind":"([^"]+)"/.exec(data.slice(0, 200))?.[1]
          const measured: Measured = {
            ev: kind && name.startsWith('doc') ? `${name} ${kind}` : name,
            task: 0,
            mutations: 0,
          }
          drain()
          mutating = measured
          afterNextTask(() => {
            measured.task = performance.now() - started
            if (mutating === measured) {
              drain()
              mutating = undefined
            }
            if (on) events.push(measured)
          })
        })
    }
  }
})
await page.goto(`${base}/?conversation=${id}`)
await page.waitForTimeout(6000)
const cdp = await page.context().newCDPSession(page)
if (profile) {
  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 })
  await cdp.send('Profiler.start')
}
await page.evaluate(() => (window as unknown as { renders: { start(): void } }).renders.start())
if (prompt)
  await page.evaluate(async (text) => {
    const hook = (
      window as unknown as {
        ultimate: {
          send(t: string): Promise<unknown>
          until(c: string, o: object): Promise<unknown>
        }
      }
    ).ultimate
    await hook.send(text)
    await hook.until('idle', { timeoutMs: 300_000 })
  }, prompt)
else await page.waitForTimeout(seconds * 1000)
if (profile) writeFileSync(profile, JSON.stringify((await cdp.send('Profiler.stop')).profile))
const events = await page.evaluate(
  () =>
    (
      window as unknown as {
        renders: {
          events: {
            ev: string
            task: number
            mutations: number
          }[]
        }
      }
    ).renders.events,
)
await browser.close()

const median = (values: number[]) => {
  const sorted = values.toSorted((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}
const quantile = (values: number[], at: number) =>
  values.toSorted((a, b) => a - b)[Math.floor((values.length - 1) * at)]
const byEvent = Map.groupBy(events, (event) => event.ev)
for (const [ev, list] of [...byEvent].toSorted((a, b) => b[1].length - a[1].length)) {
  const task = list.map((event) => event.task)
  const mutations = list.map((event) => event.mutations)
  console.log(
    JSON.stringify({
      ev,
      n: list.length,
      taskMs: { median: +median(task).toFixed(1), p95: +quantile(task, 0.95).toFixed(1) },
      mutations: { median: median(mutations), p95: quantile(mutations, 0.95) },
    }),
  )
}
