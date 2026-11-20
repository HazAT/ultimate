/** @jsxImportSource @solidjs/web */
import { render } from '@solidjs/web'
import { createAgent } from '@ui-sdk/solid/agent'
import { flush } from 'solid-js'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { FakeSource, fakeSubscriptions } from '../../../../../test/web/fake-source.ts'
import { renderSolid } from '../../../../../test/web/solid-dom-setup.ts'
import type { Entry, Progress as Data } from '../../refs.ts'

const harness = vi.hoisted(() => ({
  sources: [] as FakeSource[],
  server: undefined as ReturnType<typeof fakeSubscriptions> | undefined,
  data: undefined as Data | undefined,
}))
vi.mock('../../../../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../../../../web/src/sdk/store.ts')
  const { createApi } = await import('../../../../../web/src/sdk/api.ts')
  const { createReads } = await import('../../../../../web/src/sdk/reads.ts')
  const { createUiState } = await import('../../../../../web/src/sdk/ui-state.ts')
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = input as string
    if (path.endsWith('/solid-progress/actions/progress'))
      return Response.json({ result: harness.data })
    return harness.server?.handle(path, init) ?? Response.json({ ok: true })
  }
  const store = createStore({
    eventSource: (url) => {
      const stream = new FakeSource(url)
      harness.sources.push(stream)
      return stream
    },
    fetch,
  })
  const api = createApi(store, { fetch })
  const uiState = createUiState(async () => ({ ok: true, rev: 1 }))
  return { store, api, reads: createReads(api, store), uiState }
})

import { store, uiState } from '../../../../../web/src/sdk/client.ts'
import { ExtensionName } from '../../../../../web/src/sdk/solid.ts'
import { Progress } from '../../progress.solid.tsx'

const entry = (label: string, commit: string, react: number, solid: number): Entry => ({
  commit,
  label,
  date: '2026-11-19',
  lines: { total: react + solid, react, solid },
  perExtension: { 'keep-warm': { react, solid } },
  bundleGzipKB: null,
  entryGzipKB: null,
  switch: null,
  stream: null,
  summary: `${label} summary`,
  statuses: { 'keep-warm': solid ? 'solid' : 'react' },
})

const agent = createAgent()
harness.server = fakeSubscriptions(harness.sources)
beforeEach(async () => {
  vi.useFakeTimers()
  harness.sources.length = 0
  harness.data = {
    entries: [entry('pure React', 'aaaaaaaa', 90, 0), entry('0.1', 'bbbbbbbb', 5, 85)],
    previewUsage: [],
    live: [{ name: 'keep-warm', react: 5, solid: 87, status: 'solid' }],
  }
  store.start()
  harness.sources[0].open()
  await vi.advanceTimersByTimeAsync(10)
})
afterEach(() => {
  store.stop()
  vi.useRealTimers()
})

const page = () => (
  <ExtensionName value="solid-progress">
    <Progress />
  </ExtensionName>
)

async function settled<T>(value: T) {
  await vi.advanceTimersByTimeAsync(10)
  flush()
  return value
}

async function act(steps: Parameters<typeof agent.act>[0]['steps']) {
  const result = agent.act({ steps })
  await vi.advanceTimersByTimeAsync(100)
  flush()
  return result
}

const extensionRow = (container: HTMLElement) =>
  container.querySelector('tr[data-status]')?.textContent

it('an agent scrubs to a step, the page follows and keeps it, and Play walks on to Live', async () => {
  const first = document.body.appendChild(document.createElement('div'))
  const dispose = await settled(render(page, first))
  expect(await act([{ ref: 'Migration step', action: 'setValue', args: [0] }])).toMatchObject({
    ok: true,
  })
  expect(uiState.get('ext.solid-progress.step')).toBe('aaaaaaaa')
  expect(first.textContent).toContain('pure React summary')
  expect(extensionRow(first)).toMatch(/^keep-warmReact/)
  dispose()
  first.remove()

  const container = await settled(renderSolid(page))
  expect(container.textContent).toContain('pure React summary')
  expect(await act([{ ref: 'Play the steps', action: 'press' }])).toMatchObject({ ok: true })
  await vi.advanceTimersByTimeAsync(1200)
  flush()
  expect(uiState.get('ext.solid-progress.step')).toBe('bbbbbbbb')
  expect(extensionRow(container)).toMatch(/^keep-warmSolid/)
  await vi.advanceTimersByTimeAsync(1200)
  flush()
  expect(uiState.get('ext.solid-progress.step')).toBe('live')
  expect(container.textContent).toContain('working tree now')
  expect(container.querySelector('[aria-label="Play the steps"]')).not.toBeNull()
})
