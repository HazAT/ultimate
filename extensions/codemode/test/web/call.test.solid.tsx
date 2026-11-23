import { settle } from '@ui-sdk/core/testing'
import { createAgent } from '@ui-sdk/solid/agent'
import { flush } from 'solid-js'
import { expect, it, vi } from 'vitest'
import type { ToolCallView } from '@/sdk/solid'
import { expectDistinctAgentNames } from '../../../../test/web/agent-names.ts'
import { FakeSource, fakeSubscriptions } from '../../../../test/web/fake-source.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { CodemodeCall } from '../../call.solid.tsx'

vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createRegistry } = await import('../../../../web/src/sdk/registry.ts')
  const { createApi } = await import('../../../../web/src/sdk/api.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  const sources: FakeSource[] = []
  const server = fakeSubscriptions(sources)
  const fetch: typeof globalThis.fetch = async (path, init) =>
    server.handle(
      typeof path === 'string' ? path : path instanceof URL ? path.href : path.url,
      init,
    ) ?? Response.json({ ok: true })
  const store = createStore({
    eventSource: (url) => {
      const source = new FakeSource(url)
      sources.push(source)
      return source
    },
    fetch,
  })
  return {
    store,
    registry: createRegistry(),
    uiState: createUiState(createApi(store, { fetch }).updateUi),
  }
})

const agent = createAgent()

it('shows the finished run with its calls and output', async () => {
  const call: ToolCallView = {
    id: 'call-1',
    name: 'codemode',
    args: { code: 'text("Loaded two notes"); return { total: 2 }' },
    status: 'done',
    output: 'Script completed\nLoaded two notes\n{"total":2}',
    images: [],
    diagnostics: [],
    details: {
      calls: [
        { id: 1, name: 'read', args: '{"path":"a.md"}', status: 'ok', durationMs: 7 },
        { id: 2, name: 'bash', args: '{"command":"ls"}', status: 'error', durationMs: 11 },
      ],
    },
    result: {
      role: 'toolResult',
      toolCallId: 'call-1',
      toolName: 'codemode',
      content: [
        { type: 'text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' },
        { type: 'text', text: 'Loaded two notes\n{"total":2}' },
      ],
      isError: false,
      timestamp: 100,
    },
  }
  const container = renderSolid(() => <CodemodeCall call={call} core={null} />)
  await settle()

  expect(container.textContent).toContain('2 calls')
  expect(container.textContent).toContain('1 failed')
  const control = agent
    .snapshot()
    .find((entry) => !entry.offPage && (entry.label ?? '').startsWith('Codemode #call-1:'))
  if (!control) throw new Error('Missing control: Codemode #call-1')
  expect(
    (await agent.act({ steps: [{ ref: control.ref, action: 'setOpen', args: [true] }] })).ok,
  ).toBe(true)
  flush()
  await settle()
  expect(container.textContent).toContain('Calls · 2')
  expect(container.textContent).toContain('7ms')
  expect([...container.querySelectorAll('pre')].map((pre) => pre.textContent)).toContain(
    'Loaded two notes\n{"total":2}',
  )
  await expectDistinctAgentNames(agent)
})

it('keeps an error result that has no script header, such as a resume refused after a restart', async () => {
  const error = 'The script cannot resume: the sandbox changed since it started (a -> b).'
  const call: ToolCallView = {
    id: 'call-2',
    name: 'codemode',
    args: { code: 'await tools.read({path: "a"})' },
    status: 'error',
    output: error,
    images: [],
    diagnostics: [],
    details: { calls: [] },
    result: {
      role: 'toolResult',
      toolCallId: 'call-2',
      toolName: 'codemode',
      content: [{ type: 'text', text: error }],
      isError: true,
      timestamp: 100,
    },
  }
  const container = renderSolid(() => <CodemodeCall call={call} core={null} />)
  await settle()
  expect([...container.querySelectorAll('pre')].map((pre) => pre.textContent)).toContain(error)
})
