import { createAgent } from '@ui-sdk/solid/agent'
import { flush } from 'solid-js'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { expectDistinctAgentNames } from '../../../../test/web/agent-names.ts'
import { FakeSource, fakeSubscriptions } from '../../../../test/web/fake-source.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import type { RunningProject } from '../../refs.ts'
import { parseConversationId } from '../../../../lib/ids.ts'

const harness = vi.hoisted(() => ({
  sources: [] as FakeSource[],
  pinned: false,
  pins: [] as { pinned: boolean; source: string | null }[],
  calls: [] as string[],
  projects: [] as RunningProject[],
  slowPinReads: false,
  failPinWrites: false,
  failUnpins: false,
  rejected: [] as boolean[],
  slowWrites: [] as (() => void)[],
  holdWrites: false,
  failPinReads: false,
  release: [] as (() => void)[],
  wide: true,
}))
vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createApi } = await import('../../../../web/src/sdk/api.ts')
  const { createReads } = await import('../../../../web/src/sdk/reads.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  const { createRegistry } = await import('../../../../web/src/sdk/registry.ts')
  const subscriptions = fakeSubscriptions(harness.sources)
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = input as string
    const action = /^\/api\/extensions\/projects\/actions\/(\w+)$/.exec(path)?.[1]
    if (!action) return subscriptions.handle(path, init) ?? Response.json({ ok: true })
    harness.calls.push(action)
    if (action === 'list') return Response.json({ result: harness.projects })
    const { args } = JSON.parse(init!.body as string) as { args: { pinned?: boolean } }
    if (
      args.pinned !== undefined &&
      (harness.failPinWrites || (harness.failUnpins && !args.pinned))
    ) {
      harness.rejected.push(args.pinned)
      return Response.json({ error: 'pin file is read-only' }, { status: 500 })
    }
    if (args.pinned === undefined && harness.failPinReads)
      return Response.json({ error: 'pin file is unreadable' }, { status: 500 })
    if (args.pinned !== undefined && harness.holdWrites)
      await new Promise<void>((resolve) => harness.slowWrites.push(resolve))
    if (args.pinned !== undefined) {
      harness.pins.push({
        pinned: args.pinned,
        source: new Headers(init?.headers).get('x-ultimate-source'),
      })
      harness.pinned = args.pinned
    } else if (harness.slowPinReads) {
      const answer = { pinned: harness.pinned }
      await new Promise<void>((resolve) => harness.release.push(resolve))
      return Response.json({ result: answer })
    }
    return Response.json({ result: { pinned: harness.pinned } })
  }
  const { answerReadsWith } = await import('../../../../test/web/fake-source.ts')
  const pageFetch = answerReadsWith(fetch)
  const store = createStore({
    eventSource: (url) => {
      const source = new FakeSource(url)
      harness.sources.push(source)
      return source
    },
    fetch: pageFetch,
  })
  const api = createApi(store, { fetch: pageFetch })
  const registry = createRegistry()
  return {
    store,
    api,
    reads: createReads(api, store),
    uiState: createUiState(undefined),
    registry,
  }
})
const viewportChanges = new Set<() => void>()
vi.stubGlobal(
  'matchMedia',
  (query: string) =>
    ({
      get matches() {
        return harness.wide && query.includes('min-width')
      },
      addEventListener: (_: string, listener: () => void) => viewportChanges.add(listener),
      removeEventListener: (_: string, listener: () => void) => viewportChanges.delete(listener),
    }) as unknown as MediaQueryList,
)
const resize = (wide: boolean) => {
  harness.wide = wide
  for (const listener of viewportChanges) listener()
}

let visibility: DocumentVisibilityState = 'visible'
Object.defineProperty(document, 'visibilityState', { get: () => visibility })
function setVisibility(state: DocumentVisibilityState) {
  visibility = state
  document.dispatchEvent(new Event('visibilitychange'))
  flush()
}

import { registry, store } from '../../../../web/src/sdk/client.ts'
import { OpeningBar, Rail } from '../../rail.solid.tsx'

const agent = createAgent()
beforeAll(() => vi.useFakeTimers())
afterAll(() => vi.useRealTimers())
beforeEach(async () => {
  setVisibility('visible')
  harness.sources.length = 0
  harness.pins.length = 0
  harness.calls.length = 0
  harness.pinned = false
  harness.slowPinReads = false
  harness.failPinWrites = false
  harness.failUnpins = false
  harness.rejected.length = 0
  harness.holdWrites = false
  harness.slowWrites.length = 0
  harness.failPinReads = false
  resize(true)
  harness.projects = [
    { name: 'ultimate', url: 'http://127.0.0.1:4747', current: true, busy: 1 },
    { name: 'ultimate-eval', url: 'http://127.0.0.1:4748', current: false, questions: 2 },
    {
      name: 'my-app',
      url: 'http://127.0.0.1:4750',
      current: false,
      repo: { name: 'owner/my-app', url: 'https://github.com/owner/my-app', visibility: 'private' },
    },
  ]
  store.start()
  harness.sources[0].open()
  await vi.advanceTimersByTimeAsync(5_000)
})
afterEach(() => store.stop())

async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms)
  flush()
}

async function mount() {
  const container = renderSolid(() => (
    <>
      <Rail />
      <OpeningBar />
    </>
  ))
  await advance(100)
  return container
}

const rail = (container: HTMLElement) => container.querySelector('nav')?.parentElement
const calls = (name: string) => harness.calls.filter((call) => call === name).length

it('lists projects by name, leaves the current project unfocusable, and an agent pins the rail', async () => {
  const container = await mount()
  const rows = [...container.querySelectorAll<HTMLElement>('[data-project]')]
  expect(rows.map((row) => [row.dataset.project, row.getAttribute('href'), row.ariaLabel])).toEqual(
    [
      ['ultimate', null, 'Ultimate · :4747 · working · this tab'],
      ['ultimate-eval', 'http://127.0.0.1:4748/', 'Ultimate Eval · :4748 · 2 for you'],
      ['my-app', 'http://127.0.0.1:4750/', 'My App · owner/my-app · :4750'],
    ],
  )
  const currentRow = container.querySelector<HTMLButtonElement>('button[aria-current="page"]')!
  expect(currentRow.dataset.project).toBe('ultimate')
  expect(currentRow.disabled).toBe(true)
  rows[1].focus()
  currentRow.focus()
  expect(document.activeElement).toBe(rows[1])
  rows[1].blur()
  flush()

  rail(container)!.dispatchEvent(new MouseEvent('mouseenter'))
  await advance(149)
  expect(container.textContent).not.toContain('working')
  await advance(1)
  expect(container.textContent).toContain('2 for you · 1 working')
  await expectDistinctAgentNames(agent)

  const current = agent
    .snapshot()
    .find((entry) => !entry.offPage && entry.label === currentRow.ariaLabel)
  expect(current).toMatchObject({ disabled: true })
  expect(await agent.query({ text: 'Ultimate' })).toEqual(
    expect.arrayContaining([expect.objectContaining({ ref: current!.ref })]),
  )
  const blocked = agent.act({ steps: [{ ref: current!.ref, action: 'press' }] })
  await advance(100)
  expect((await blocked).ok).toBe(false)
  expect(await agent.query({ text: 'My App' })).toEqual(
    expect.arrayContaining([expect.objectContaining({ label: rows[2].ariaLabel })]),
  )
  const pin = agent.snapshot().find((entry) => entry.label === 'Pin the projects rail open')
  expect(pin?.pressed).toBe(false)
  const pressed = agent.act({ steps: [{ ref: pin!.ref, action: 'setPressed', args: [true] }] })
  await advance(100)
  expect(await pressed).toMatchObject({ ok: true })
  expect(harness.pins).toEqual([{ pinned: true, source: 'agent' }])
  rail(container)!.dispatchEvent(new MouseEvent('mouseleave'))
  await advance(10)
  expect(
    container.querySelector('[aria-label="Unpin the projects rail"]')?.getAttribute('aria-pressed'),
  ).toBe('true')
  container.querySelector<HTMLButtonElement>('[aria-label="Unpin the projects rail"]')!.click()
  await advance(10)
  expect(harness.pins.at(-1)).toEqual({ pinned: false, source: 'person' })
})

const pinButton = (container: HTMLElement, label: string) =>
  container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!
const pinnedOpen = (container: HTMLElement) => rail(container)!.className.includes('w-68')

async function openRail(container: HTMLElement) {
  rail(container)!.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
  await advance(10)
}
async function closeRail(container: HTMLElement) {
  rail(container)!.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
  await advance(10)
}

it('keeps a pin over a shared-pin read that was still answering when it was pressed', async () => {
  harness.slowPinReads = true
  const container = renderSolid(() => <Rail />)
  await advance(100)
  expect(harness.release).toHaveLength(1)
  harness.slowPinReads = false
  await openRail(container)
  pinButton(container, 'Pin the projects rail open').click()
  await advance(10)
  await closeRail(container)
  expect(pinnedOpen(container)).toBe(true)

  for (const release of harness.release.splice(0)) release()
  await advance(10)
  expect(harness.pins).toEqual([{ pinned: true, source: 'person' }])
  expect(pinnedOpen(container)).toBe(true)
})

it('falls back to the stored pin when writing it fails', async () => {
  const container = await mount()
  harness.failPinWrites = true
  await openRail(container)
  pinButton(container, 'Pin the projects rail open').click()
  await advance(10)
  await closeRail(container)
  expect(harness.pins).toEqual([])
  expect(pinnedOpen(container)).toBe(false)

  harness.failPinWrites = false
  harness.pinned = true
  await advance(30_000)
  expect(pinnedOpen(container)).toBe(true)
})

it('keeps a saved pin when the read after it fails, and when the unpin after it fails', async () => {
  const container = await mount()
  await advance(30_000)
  harness.failPinReads = true
  await openRail(container)
  pinButton(container, 'Pin the projects rail open').click()
  await advance(10)
  await closeRail(container)
  expect(harness.pins).toEqual([{ pinned: true, source: 'person' }])
  expect(pinnedOpen(container)).toBe(true)
  await openRail(container)
  harness.failUnpins = true
  pinButton(container, 'Unpin the projects rail').click()
  await advance(10)
  await closeRail(container)
  expect(harness.rejected).toEqual([false])
  expect(harness.pins).toEqual([{ pinned: true, source: 'person' }])
  expect(pinnedOpen(container)).toBe(true)
})

it('holds a pressed control until its write settles, also on a reopened rail', async () => {
  const container = await mount()
  await openRail(container)
  const button = pinButton(container, 'Pin the projects rail open')
  button.click()
  button.click()
  await advance(10)
  expect(harness.pins).toEqual([{ pinned: true, source: 'person' }])
  harness.holdWrites = true
  pinButton(container, 'Unpin the projects rail').click()
  await advance(10)
  await closeRail(container)
  await openRail(container)
  pinButton(container, 'Pin the projects rail open').click()
  await advance(10)
  expect(harness.slowWrites).toHaveLength(1)
  for (const release of harness.slowWrites.splice(0)) release()
  await advance(10)
  await closeRail(container)
  expect(harness.pins).toEqual([
    { pinned: true, source: 'person' },
    { pinned: false, source: 'person' },
  ])
  expect(pinnedOpen(container)).toBe(false)
})

it('reads the machine-wide pin once, whichever conversation is shown', async () => {
  const container = await mount()
  harness.failPinReads = true
  await openRail(container)
  pinButton(container, 'Pin the projects rail open').click()
  await advance(10)
  await closeRail(container)
  const reads = calls('pin')
  store.show(parseConversationId(42))
  await advance(100)
  expect(calls('pin')).toBe(reads)
  expect(pinnedOpen(container)).toBe(true)
})

it('polls the list every 4 s and the shared pin every 30 s, only while the tab is shown', async () => {
  setVisibility('hidden')
  harness.projects = harness.projects.slice(0, 1)
  const container = await mount()
  expect(container.querySelector('nav')).toBeNull()
  const hidden = [calls('list'), calls('pin')]
  await advance(60_000)
  expect([calls('list'), calls('pin')]).toEqual(hidden)

  harness.projects = [
    ...harness.projects,
    { name: 'my-app', url: 'http://127.0.0.1:4750', current: false },
  ]
  setVisibility('visible')
  await advance(10)
  expect(container.querySelectorAll('[data-project]')).toHaveLength(2)
  expect([calls('list'), calls('pin')]).toEqual([hidden[0] + 1, hidden[1] + 1])
  await advance(3_989)
  expect(calls('list')).toBe(hidden[0] + 1)
  await advance(1)
  expect(calls('list')).toBe(hidden[0] + 2)
  await advance(4_000)
  expect(calls('list')).toBe(hidden[0] + 3)
  await advance(21_999)
  expect(calls('pin')).toBe(hidden[1] + 1)
  await advance(1)
  expect(calls('pin')).toBe(hidden[1] + 2)

  setVisibility('hidden')
  const stopped = [calls('list'), calls('pin')]
  await advance(60_000)
  expect([calls('list'), calls('pin')]).toEqual(stopped)
})

it('gives way to another extension’s rail and to a phone', async () => {
  const container = await mount()
  expect(container.querySelector('nav')).not.toBeNull()
  resize(false)
  flush()
  expect(container.querySelector('nav')).toBeNull()
  const suppressed = calls('list') + calls('pin')
  await advance(60_000)
  expect(calls('list') + calls('pin')).toBe(suppressed)
  resize(true)
  flush()
  expect(container.querySelector('nav')).not.toBeNull()

  await registry.setLoaders({
    '/extensions/projects/web.solid.tsx': async () => ({ default: {} }),
    '/extensions/fleet/web.solid.tsx': async () => ({
      default: { slots: { 'shell.rail': () => null } },
    }),
  })
  flush()
  expect(container.querySelector('nav')).toBeNull()
  const beside = calls('list') + calls('pin')
  await advance(60_000)
  expect(calls('list') + calls('pin')).toBe(beside)
  await registry.setLoaders({})
})

it('shows the opening bar after a click until the page is left, shown again, or 15 s pass', async ({
  onTestFinished,
}) => {
  const container = await mount()
  const bar = () => container.querySelector('.animate-sweep')
  const evalRow = container.querySelector<HTMLAnchorElement>('a[data-project="ultimate-eval"]')!
  const preventNavigation = (event: MouseEvent) => event.preventDefault()
  window.addEventListener('click', preventNavigation)
  onTestFinished(() => window.removeEventListener('click', preventNavigation))
  evalRow.click()
  flush()
  expect(bar()).not.toBeNull()
  expect(evalRow.ariaLabel).toContain('opening')
  expect(evalRow.parentElement?.title).toContain('opening')
  window.dispatchEvent(new Event('pageshow'))
  flush()
  expect(bar()).toBeNull()

  evalRow.click()
  flush()
  await advance(14_999)
  expect(bar()).not.toBeNull()
  await advance(1)
  expect(bar()).toBeNull()
})
