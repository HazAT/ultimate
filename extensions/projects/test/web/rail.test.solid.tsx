/** @jsxImportSource @solidjs/web */
import { settle } from '@ui-sdk/core/testing'
import { createAgent } from '@ui-sdk/solid/agent'
import { flush } from 'solid-js'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { expectDistinctAgentNames } from '../../../../test/web/agent-names.ts'
import { FakeSource, fakeSubscriptions } from '../../../../test/web/fake-source.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import type { RunningProject } from '../../refs.ts'

const harness = vi.hoisted(() => ({
  sources: [] as FakeSource[],
  server: undefined as ReturnType<typeof fakeSubscriptions> | undefined,
  pinned: false,
  pins: [] as { args: unknown; source: string | null }[],
  projects: [] as RunningProject[],
}))
vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createApi } = await import('../../../../web/src/sdk/api.ts')
  const { createReads } = await import('../../../../web/src/sdk/reads.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  const { createRegistry } = await import('../../../../web/src/sdk/registry.ts')
  const subscriptions = (harness.server = fakeSubscriptions(harness.sources))
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = input as string
    if (path === '/api/extensions/projects/actions/list')
      return Response.json({ result: harness.projects })
    if (path === '/api/extensions/projects/actions/pin') {
      const { args } = JSON.parse(init!.body as string) as { args: { pinned?: boolean } }
      if (args.pinned !== undefined) {
        harness.pins.push({ args, source: new Headers(init?.headers).get('x-ultimate-source') })
        harness.pinned = args.pinned
      }
      return Response.json({ result: { pinned: harness.pinned } })
    }
    return subscriptions.handle(path, init) ?? Response.json({ ok: true })
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
  return {
    store,
    api,
    reads: createReads(api, store),
    uiState: createUiState(undefined),
    registry: createRegistry(),
  }
})
vi.stubGlobal(
  'matchMedia',
  (query: string) =>
    ({
      matches: query.includes('min-width'),
      addEventListener: () => {},
      removeEventListener: () => {},
    }) as unknown as MediaQueryList,
)

import { store } from '../../../../web/src/sdk/client.ts'
import { Rail } from '../../rail.solid.tsx'

const agent = createAgent()
beforeEach(() => {
  harness.sources.length = 0
  harness.pins.length = 0
  harness.pinned = false
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
})
afterEach(() => store.stop())

let visibility: DocumentVisibilityState = 'visible'
Object.defineProperty(document, 'visibilityState', { get: () => visibility })

async function settled() {
  await settle()
  flush()
  await settle()
  flush()
}

async function showTabAgain() {
  for (const state of ['hidden', 'visible'] as const) {
    visibility = state
    document.dispatchEvent(new Event('visibilitychange'))
    flush()
  }
  await settled()
}

async function mount() {
  const container = renderSolid(() => <Rail />)
  await settled()
  await showTabAgain()
  return container
}

it('lists each running project as a link with its state, and an agent pins the rail open for every instance', async () => {
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

  container
    .querySelector('nav')!
    .parentElement!.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
  flush()
  expect(container.textContent).toContain('2 for you · 1 working')
  await expectDistinctAgentNames(agent)

  const pin = agent.snapshot().find((entry) => entry.label === 'Pin the projects rail open')
  expect(await agent.act({ steps: [{ ref: pin!.ref, action: 'press' }] })).toMatchObject({
    ok: true,
  })
  await settle()
  flush()
  expect(harness.pins).toEqual([{ args: { pinned: true }, source: 'agent' }])
  expect(
    container.querySelector('[aria-label="Unpin the projects rail"]')?.getAttribute('aria-pressed'),
  ).toBe('true')
})

it('shows nothing while fewer than two projects run, and asks again when the tab is shown', async () => {
  const running = harness.projects
  harness.projects = running.slice(0, 1)
  const container = await mount()
  expect(container.querySelector('nav')).toBeNull()

  harness.projects = running
  await showTabAgain()
  expect(container.querySelectorAll('a[data-project]')).toHaveLength(3)
})
