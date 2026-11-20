/** @jsxImportSource @solidjs/web */
import { createAgent } from '@ui-sdk/solid/agent'
import { flush } from 'solid-js'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { expectDistinctAgentNames } from '../../../../test/web/agent-names.ts'
import { FakeSource, fakeSubscriptions } from '../../../../test/web/fake-source.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import type { RunningProject } from '../../refs.ts'

const harness = vi.hoisted(() => ({
  sources: [] as FakeSource[],
  pinned: false,
  pins: [] as { pinned: boolean; source: string | null }[],
  calls: [] as string[],
  projects: [] as RunningProject[],
  slowPinReads: false,
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
  const store = createStore({
    eventSource: (url) => {
      const source = new FakeSource(url)
      harness.sources.push(source)
      return source
    },
    fetch,
  })
  const api = createApi(store, { fetch })
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

import { registry, store } from '../../../../web/src/sdk/client.ts'
import { OpeningBar, Rail } from '../../rail.solid.tsx'

const agent = createAgent()
beforeAll(() => vi.useFakeTimers())
afterAll(() => vi.useRealTimers())
beforeEach(async () => {
  visibility = 'visible'
  harness.sources.length = 0
  harness.pins.length = 0
  harness.calls.length = 0
  harness.pinned = false
  harness.slowPinReads = false
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

it('lists each running project as a link with its state, opens on hover, and an agent pins it for every instance', async () => {
  const container = await mount()
  const rows = [...container.querySelectorAll<HTMLAnchorElement>('a[data-project]')]
  expect(rows.map((row) => [row.dataset.project, row.getAttribute('href'), row.title])).toEqual([
    ['ultimate', null, 'Ultimate · :4747 · working · this tab'],
    ['ultimate-eval', 'http://127.0.0.1:4748/', 'Ultimate Eval · :4748 · 2 for you'],
    ['my-app', 'http://127.0.0.1:4750/', 'My App · owner/my-app · :4750'],
  ])
  expect(container.querySelector<HTMLElement>('a[aria-current="page"]')?.dataset.project).toBe(
    'ultimate',
  )

  rail(container)!.dispatchEvent(new MouseEvent('mouseenter'))
  await advance(100)
  expect(container.textContent).not.toContain('working')
  await advance(50)
  expect(container.textContent).toContain('2 for you · 1 working')
  await expectDistinctAgentNames(agent)

  const pin = agent.snapshot().find((entry) => entry.label === 'Pin the projects rail open')
  const pressed = agent.act({ steps: [{ ref: pin!.ref, action: 'press' }] })
  await advance(100)
  expect(await pressed).toMatchObject({ ok: true })
  expect(harness.pins).toEqual([{ pinned: true, source: 'agent' }])
  rail(container)!.dispatchEvent(new MouseEvent('mouseleave'))
  await advance(10)
  expect(
    container.querySelector('[aria-label="Unpin the projects rail"]')?.getAttribute('aria-pressed'),
  ).toBe('true')
})

it('keeps a pin while a shared-pin read that started before it is still answering', async () => {
  const container = await mount()
  harness.slowPinReads = true
  visibility = 'hidden'
  document.dispatchEvent(new Event('visibilitychange'))
  visibility = 'visible'
  document.dispatchEvent(new Event('visibilitychange'))
  await advance(10)
  rail(container)!.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
  await advance(10)
  container.querySelector<HTMLButtonElement>('[aria-label="Pin the projects rail open"]')!.click()
  await advance(10)
  rail(container)!.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
  await advance(10)
  expect(rail(container)!.className).toContain('w-68')

  for (const release of harness.release.splice(0)) release()
  await advance(10)
  expect(harness.pins).toEqual([{ pinned: true, source: 'person' }])
  expect(rail(container)!.className).toContain('w-68')
})

it('polls only while the tab is shown, and asks again when it is', async () => {
  visibility = 'hidden'
  harness.projects = harness.projects.slice(0, 1)
  const container = await mount()
  expect(container.querySelector('nav')).toBeNull()
  const listed = calls('list')
  await advance(60_000)
  expect(calls('list')).toBe(listed)

  harness.projects = [
    ...harness.projects,
    { name: 'my-app', url: 'http://127.0.0.1:4750', current: false },
  ]
  visibility = 'visible'
  document.dispatchEvent(new Event('visibilitychange'))
  await advance(10)
  expect(container.querySelectorAll('a[data-project]')).toHaveLength(2)
  const shown = calls('list')
  await advance(4_000)
  expect(calls('list')).toBe(shown + 1)
})

it('gives way to another extension’s rail and to a phone', async () => {
  const container = await mount()
  expect(container.querySelector('nav')).not.toBeNull()
  resize(false)
  flush()
  expect(container.querySelector('nav')).toBeNull()
  resize(true)
  flush()
  expect(container.querySelector('nav')).not.toBeNull()

  await registry.setLoaders({
    '/extensions/projects/web.tsx': async () => ({ default: {} }),
    '/extensions/fleet/web.tsx': async () => ({ default: { slots: { 'shell.rail': () => null } } }),
  })
  flush()
  expect(container.querySelector('nav')).toBeNull()
  await registry.setLoaders({})
})

it('shows the opening bar after a click until the page is left, shown again, or 15 s pass', async () => {
  const container = await mount()
  const bar = () => container.querySelector('.animate-sweep')
  const evalRow = container.querySelector<HTMLAnchorElement>('a[data-project="ultimate-eval"]')!
  evalRow.addEventListener('click', (event) => event.preventDefault())
  evalRow.click()
  flush()
  expect(bar()).not.toBeNull()
  expect(evalRow.title).toContain('opening')
  window.dispatchEvent(new Event('pageshow'))
  flush()
  expect(bar()).toBeNull()

  evalRow.click()
  flush()
  await advance(15_000)
  expect(bar()).toBeNull()
})
