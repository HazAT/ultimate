/** @jsxImportSource @solidjs/web */
import { settle } from '@ui-sdk/core/testing'
import { createAgent } from '@ui-sdk/solid/agent'
import { createElement as h } from 'react'
import { flush } from 'solid-js'
import { expect, it, vi } from 'vitest'
import { SOURCE_HEADER } from '../../../../shared/protocol.ts'
import type { UiUpdateRequest } from '../../../../shared/protocol.ts'
import { FakeSource, fakeSubscriptions } from '../../../../test/web/fake-source.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { System } from '../../surface.solid.tsx'
import { SystemTab, SYSTEM_TAB_KEY } from '../../ui.solid.tsx'

const harness = vi.hoisted(() => ({
  writes: [] as { key: string; value: unknown; source: string | null }[],
  sources: [] as FakeSource[],
}))
vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createApi } = await import('../../../../web/src/sdk/api.ts')
  const { createReads } = await import('../../../../web/src/sdk/reads.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  const { createRegistry } = await import('../../../../web/src/sdk/registry.ts')
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = input as string
    if (path === '/api/ui') {
      const { ops } = JSON.parse(init!.body as string) as UiUpdateRequest
      for (const { key, value } of ops)
        harness.writes.push({ key, value, source: new Headers(init?.headers).get(SOURCE_HEADER) })
      return Response.json({ ok: true, rev: harness.writes.length })
    }
    if (path.endsWith('/system/actions/lanes')) {
      const now = Date.now()
      const start = new Date(now - 60_000).toISOString()
      return Response.json({
        result: {
          now: new Date(now).toISOString(),
          links: [],
          lanes: [
            {
              conversation: 8,
              kind: 'standing',
              agent: 'ultimate',
              runs: [
                {
                  start,
                  calls: [
                    { at: start, ms: 10, kind: 'tool', name: 'read', ok: true, trace: 'call-1' },
                  ],
                },
              ],
            },
          ],
        },
      })
    }
    if (path.endsWith('/system/actions/stream'))
      return Response.json({
        result: {
          rows: [
            {
              id: 'no-trace',
              at: new Date().toISOString(),
              kind: 'event',
              name: 'Missing trace',
              ok: true,
              summary: 'Event without details',
            },
          ],
          head: 'first',
        },
      })
    return server.handle(path, init) ?? Response.json({ result: undefined })
  }
  const { answerReadsWith } = await import('../../../../test/web/fake-source.ts')
  const server = fakeSubscriptions(harness.sources)
  const pageFetch = answerReadsWith(fetch)
  const store = createStore({
    fetch: pageFetch,
    eventSource: (url) => {
      const source = new FakeSource(url)
      harness.sources.push(source)
      return source
    },
  })
  const api = createApi(store, { fetch: pageFetch })
  return {
    api,
    store,
    reads: createReads(api, store),
    registry: createRegistry(),
    uiState: createUiState(api.updateUi),
  }
})

import { registry, store, uiState } from '../../../../web/src/sdk/client.ts'
import { ExtensionName } from '../../../../web/src/sdk/solid.ts'

const agent = createAgent()

it('switches to a contributed System tab and picks an Agents window, attributing both writes to the agent', async ({
  onTestFinished,
}) => {
  store.start()
  onTestFinished(() => store.stop())
  harness.sources.at(-1)!.open()
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {} }))
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  await registry.setLoaders({
    'extensions/example/web.tsx': async () => ({
      default: {
        provides: [
          {
            point: SystemTab.point,
            use: () => ({
              id: 'example',
              title: 'Example',
              component: () => h('main', { 'data-example': '' }, 'React tab'),
            }),
          },
        ],
      },
    }),
  })
  const page = renderSolid(() => (
    <ExtensionName value="system">
      <System />
    </ExtensionName>
  ))
  await settle()
  flush()
  expect(page.querySelector('[data-lane="8"]')).not.toBeNull()
  await settle()
  flush()
  const noTrace = page.querySelector<HTMLButtonElement>(
    '[aria-label="Missing trace · event or call no-trace"]',
  )!
  expect(noTrace.disabled).toBe(true)
  noTrace.focus()
  expect(document.activeElement).not.toBe(noTrace)
  expect(
    agent.snapshot().find((entry) => entry.label === 'Missing trace · event or call no-trace'),
  ).toMatchObject({ disabled: true, open: false, actions: [] })
  const choose = async (label: string, value: string) => {
    const control = agent.snapshot().find((entry) => !entry.offPage && entry.label === label)
    const result = await agent.act({
      steps: [{ ref: control!.ref, action: 'setValue', args: [value] }],
    })
    expect(result).toMatchObject({ ok: true })
    await uiState.flush()
    flush()
  }
  await choose('System view', 'Example')
  expect(agent.snapshot().find((entry) => entry.label === 'System view')).toMatchObject({
    component: 'tabs',
    value: 'example',
  })
  expect(page.querySelector('[data-example]')?.textContent).toBe('React tab')
  expect(page.querySelector('[data-lane]')).toBeNull()
  await choose('System view', 'agents')
  await choose('Agent timeline window', '2h')
  expect(harness.writes).toEqual([
    { key: SYSTEM_TAB_KEY, source: 'agent', value: 'example' },
    { key: SYSTEM_TAB_KEY, source: 'agent', value: 'agents' },
    { key: 'ext.system.window', source: 'agent', value: '2h' },
  ])
})
