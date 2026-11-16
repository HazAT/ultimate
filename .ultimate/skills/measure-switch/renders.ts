// Measure what each server event costs a page: main-thread time until the next task, React components rendered, and
// the components whose own update started those renders. Watches an open conversation, or sends one prompt and waits.
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
  type Fiber = {
    tag: number
    type: unknown
    flags: number
    child: Fiber | null
    sibling: Fiber | null
    alternate: Fiber | null
    memoizedProps: unknown
    memoizedState: unknown
  }
  const w = window as unknown as Record<string, unknown>
  type Measured = { ev: string; task: number; renders: number; owners: Record<string, number> }
  const events: Measured[] = []
  let current: Measured | undefined
  let on = false
  w.renders = { events, start: () => (on = true) }
  const nameOf = (type: unknown) => {
    const t = type as { displayName?: string; name?: string; render?: { name?: string } } | null
    return t?.displayName || t?.name || t?.render?.name || '?'
  }
  const FUNCTION = 0
  const FORWARD_REF = 11
  const SIMPLE_MEMO = 15
  const PERFORMED_WORK = 1
  // A minimal devtools hook: React calls it on every commit. A component counts as rendered when it did work in this
  // commit with new props or state; its owner is the outermost rendered component above it whose parent did not render.
  w['__REACT_DEVTOOLS_GLOBAL_HOOK__'] = {
    supportsFiber: true,
    renderers: new Map(),
    inject: () => 1,
    checkDCE: () => {},
    onScheduleFiberRoot: () => {},
    onCommitFiberUnmount: () => {},
    onPostCommitFiberRoot: () => {},
    onCommitFiberRoot: (_: number, root: { current: Fiber }) => {
      const stack: [Fiber, string | undefined][] = [[root.current, undefined]]
      while (stack.length) {
        const [fiber, owner] = stack.pop()!
        let below = owner
        const component = [FUNCTION, FORWARD_REF, SIMPLE_MEMO].includes(fiber.tag)
        const fresh =
          fiber.alternate === null ||
          fiber.memoizedProps !== fiber.alternate.memoizedProps ||
          fiber.memoizedState !== fiber.alternate.memoizedState
        if (component && fiber.flags & PERFORMED_WORK && fresh) {
          below = owner ?? nameOf(fiber.type)
          if (current) {
            current.renders++
            current.owners[below] = (current.owners[below] ?? 0) + 1
          }
        } else if (component) below = undefined
        const reused = fiber.alternate !== null && fiber.child === fiber.alternate.child
        if (fiber.child && !reused) stack.push([fiber.child, below])
        if (fiber.sibling) stack.push([fiber.sibling, owner])
      }
    },
  }
  // React renders a store change in a microtask, so the time until the next task covers the handler, render and commit.
  const channel = new MessageChannel()
  const waiting: (() => void)[] = []
  channel.port1.addEventListener('message', () => waiting.shift()?.())
  channel.port1.start()
  const afterNextTask = (then: () => void) => {
    waiting.push(then)
    channel.port2.postMessage(0)
  }
  // Listeners run in the order they were added, so these run before the store's and start each event's clock. Commits
  // count toward the latest event: React flushes a store change before the next server event is dispatched.
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
            renders: 0,
            owners: {},
          }
          current = measured
          afterNextTask(() => {
            measured.task = performance.now() - started
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
          events: { ev: string; task: number; renders: number; owners: Record<string, number> }[]
        }
      }
    ).renders.events,
)
await browser.close()

const quantile = (values: number[], at: number) =>
  values.toSorted((a, b) => a - b)[Math.floor((values.length - 1) * at)]
const byEvent = Map.groupBy(events, (event) => event.ev)
for (const [ev, list] of [...byEvent].toSorted((a, b) => b[1].length - a[1].length)) {
  const task = list.map((event) => event.task)
  const renders = list.map((event) => event.renders)
  const owners: Record<string, number> = {}
  for (const event of list)
    for (const [name, count] of Object.entries(event.owners))
      owners[name] = (owners[name] ?? 0) + count
  const top = Object.entries(owners)
    .toSorted((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => `${name} ${Math.round(count / list.length)}`)
  console.log(
    JSON.stringify({
      ev,
      n: list.length,
      taskMs: { median: +quantile(task, 0.5).toFixed(1), p95: +quantile(task, 0.95).toFixed(1) },
      renders: { median: quantile(renders, 0.5), max: Math.max(...renders) },
      owners: top.join(', '),
    }),
  )
}
