/** @jsxImportSource @solidjs/web */
import { createAgent } from '@ui-sdk/solid/agent'
import { flush } from 'solid-js'
import { expect, it, vi } from 'vitest'
import { ExtensionName } from '@/sdk/solid'
import { SOURCE_HEADER } from '../../../../shared/protocol.ts'
import type { UiUpdateRequest } from '../../../../shared/protocol.ts'
import { FakeSource } from '../../../../test/web/fake-source.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { store, uiState } from '../../../../web/src/sdk/client.ts'
import { Control } from '../../chip.solid.tsx'

const harness = vi.hoisted(() => ({
  stream: undefined as FakeSource | undefined,
  writes: [] as { key: string; value: unknown; source: string | null }[],
}))
vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createApi } = await import('../../../../web/src/sdk/api.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  const { createRegistry } = await import('../../../../web/src/sdk/registry.ts')
  const fetch = async (path: RequestInfo | URL, init?: RequestInit) => {
    if (path !== '/api/ui') return Response.json({ ok: true })
    const { ops } = JSON.parse(init!.body as string) as UiUpdateRequest
    const source = new Headers(init?.headers).get(SOURCE_HEADER)
    for (const { key, value } of ops) harness.writes.push({ key, value, source })
    return Response.json({ ok: true, rev: 1 })
  }
  const clientStore = createStore({
    eventSource: (url) => (harness.stream = new FakeSource(url)),
    fetch,
  })
  const api = createApi(clientStore, { fetch })
  return {
    store: clientStore,
    api,
    registry: createRegistry(),
    uiState: createUiState(api.updateUi),
  }
})

const agent = createAgent()
function control(label: string, component: string) {
  const entry = agent
    .snapshot()
    .find((item) => !item.offPage && item.label === label && item.component === component)
  if (!entry) throw new Error(`Missing ${component}: ${label}`)
  return entry
}

it('lets an agent open Sounds, set the variant and volume, and turn sounds off', async ({
  onTestFinished,
}) => {
  store.start()
  onTestFinished(() => store.stop())
  harness.stream!.open()
  uiState.receive({ 'ext.sounds.agents': 'ambient' })
  const container = renderSolid(() => (
    <ExtensionName value="sounds">
      <Control />
    </ExtensionName>
  ))
  const changes = vi.fn<Parameters<typeof agent.subscribe>[0]>()
  onTestFinished(agent.subscribe(changes))
  const opened = await agent.act({
    steps: [{ ref: control('Sounds', 'popover').ref, action: 'setOpen', args: [true] }],
  })
  expect(opened).toMatchObject({ ok: true })
  const variant = control('Variant', 'segmented-control')
  expect(variant).toMatchObject({ value: 'chiptune' })
  const orchestra = variant.items?.find((item) => item.label === 'Orchestra')
  expect(orchestra?.value).toBe('orchestra')
  const changed = await agent.act({
    steps: [
      { ref: variant.ref, action: 'setValue', args: [orchestra!.value] },
      { ref: control('Volume', 'slider').ref, action: 'setValue', args: [0.45] },
      { ref: control('Sounds', 'switch').ref, action: 'setChecked', args: [false] },
    ],
  })
  expect(changed).toMatchObject({ ok: true })
  flush()
  expect(container.querySelector('input[aria-label="Volume"]')).toMatchObject({
    value: '0.45',
    disabled: true,
  })
  expect(container.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('false')
  await uiState.flush()
  expect(harness.writes).toEqual([
    { key: 'ext.sounds.agents', value: 'orchestra', source: 'agent' },
    { key: 'ext.sounds.volume', value: 0.45, source: 'agent' },
    { key: 'ext.sounds.muted', value: true, source: 'agent' },
  ])
  expect(changes).toHaveBeenCalledWith(
    expect.objectContaining({ label: 'Volume', key: 'value', value: 0.45, source: 'agent' }),
  )
})
