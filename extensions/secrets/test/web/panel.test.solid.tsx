/** @jsxImportSource @solidjs/web */
import { createAgent } from '@ui-sdk/solid/agent'
import { settle } from '@ui-sdk/core/testing'
import { flush } from 'solid-js'
import { expect, it, vi } from 'vitest'
import { SOURCE_HEADER } from '../../../../shared/protocol.ts'
import { FakeSource } from '../../../../test/web/fake-source.ts'
import { expectDistinctAgentNames } from '../../../../test/web/agent-names.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { reads, store } from '../../../../web/src/sdk/client.ts'
import { SecretsPanel } from '../../panel.solid.tsx'
import type { Secret } from '../../refs.ts'

const harness = vi.hoisted(() => ({
  stream: undefined as FakeSource | undefined,
  secrets: [] as Secret[],
  request: vi.fn<typeof fetch>(),
}))
vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createApi } = await import('../../../../web/src/sdk/api.ts')
  const { createReads } = await import('../../../../web/src/sdk/reads.ts')
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  harness.request.mockImplementation(async (path, init) => {
    if (path === '/api/extensions/secrets/actions/list')
      return Response.json({ result: harness.secrets })
    if (path === '/api/extensions/secrets/actions/set') {
      const { args } = JSON.parse(init!.body as string) as { args: { name: string } }
      harness.secrets.push({ name: args.name, declaredBy: [], set: true })
      return Response.json({ result: { name: args.name, set: true } })
    }
    return Response.json({ ok: true })
  })
  const clientStore = createStore({
    eventSource: (url) => (harness.stream = new FakeSource(url)),
    fetch: harness.request,
  })
  const api = createApi(clientStore, { fetch: harness.request })
  return {
    store: clientStore,
    api,
    reads: createReads(api, clientStore),
    uiState: createUiState(api.updateUi),
  }
})

const agent = createAgent()
function refFor(label: string) {
  const matches = agent.snapshot().filter((entry) => !entry.offPage && entry.label === label)
  expect(matches).toHaveLength(1)
  return matches[0].ref
}

it('lets an agent add a named secret without reading it back, but not replace one unconfirmed', async ({
  onTestFinished,
}) => {
  store.start()
  onTestFinished(() => store.stop())
  harness.stream!.open()
  const panel = renderSolid(() => <SecretsPanel />)
  await reads.settledInUse()
  flush()
  const changes = vi.fn<Parameters<typeof agent.subscribe>[0]>()
  onTestFinished(agent.subscribe(changes))

  const open = await agent.act({ steps: [{ ref: refFor('Add a secret'), action: 'press' }] })
  expect(open.ok).toBe(true)
  flush()
  await settle()
  await expectDistinctAgentNames(agent)
  expect(document.activeElement?.getAttribute('aria-label')).toBe('Name of the new secret')
  const value = 'test-token-not-a-secret'
  const filled = await agent.act({
    steps: [
      { ref: refFor('Name of the new secret'), action: 'setValue', args: ['demo_key'] },
      { ref: refFor('Value'), action: 'setValue', args: [value] },
    ],
  })
  expect(filled.ok).toBe(true)
  flush()
  expect(panel.querySelector('input[aria-label="Name of the new secret"]')).toMatchObject({
    value: 'DEMO_KEY',
  })
  expect(JSON.stringify([agent.snapshot(), filled, changes.mock.calls])).not.toContain(value)

  const saved = await agent.act({ steps: [{ ref: refFor('Save new secret'), action: 'press' }] })
  expect(saved.ok).toBe(true)
  await settle()
  flush()
  const writes = harness.request.mock.calls.filter(
    ([path]) => path === '/api/extensions/secrets/actions/set',
  )
  expect(writes).toHaveLength(1)
  const [, init] = writes[0]
  expect(JSON.parse(init!.body as string)).toMatchObject({ args: { name: 'DEMO_KEY', value } })
  expect(new Headers(init!.headers).get(SOURCE_HEADER)).toBe('agent')
  expect(panel.querySelector('input[aria-label="Value"]')).toBeNull()
  expect(panel.querySelector('li[aria-label="DEMO_KEY"]')?.textContent).toContain('set')

  const replace = await agent.act({ steps: [{ ref: refFor('Replace DEMO_KEY'), action: 'press' }] })
  expect(replace.ok).toBe(true)
  flush()
  await settle()
  await expectDistinctAgentNames(agent)
  await agent.act({
    steps: [{ ref: refFor('New value for DEMO_KEY'), action: 'setValue', args: ['next'] }],
  })
  flush()
  const unconfirmed = await agent.act({
    steps: [{ ref: refFor('Save secret DEMO_KEY'), action: 'press' }],
  })
  expect(unconfirmed.ok).toBe(false)
  await settle()
  expect(
    harness.request.mock.calls.filter(([path]) => path === '/api/extensions/secrets/actions/set'),
  ).toHaveLength(1)
})
