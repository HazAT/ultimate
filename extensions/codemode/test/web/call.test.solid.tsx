/** @jsxImportSource @solidjs/web */
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

it('shows the finished run and lets an agent open its returned value', async () => {
  const call: ToolCallView = {
    id: 'call-1',
    name: 'codemode',
    args: { code: 'text("Loaded two notes"); return { total: 2 }' },
    status: 'done',
    output: '2 calls\nLoaded two notes\n{"total":2}',
    images: [],
    diagnostics: [],
    details: {
      calls: [
        { name: 'ultimate.entries', args: [42], status: 'ok', ms: 7 },
        { name: 'ultimate.search', args: ['notes'], status: 'ok', ms: 11 },
      ],
      value: { total: 2 },
    },
    result: {
      role: 'toolResult',
      toolCallId: 'call-1',
      toolName: 'codemode',
      content: [
        { type: 'text', text: '2 calls' },
        { type: 'text', text: 'Loaded two notes' },
        { type: 'text', text: '{"total":2}' },
      ],
      isError: false,
      timestamp: 100,
    },
  }
  const container = renderSolid(() => <CodemodeCall call={call} core={null} />)
  await settle()

  const setOpen = async (label: RegExp, open: boolean) => {
    const control = agent
      .snapshot()
      .find((entry) => !entry.offPage && label.test(entry.label ?? ''))
    if (!control) throw new Error(`Missing control: ${label}`)
    expect(
      (await agent.act({ steps: [{ ref: control.ref, action: 'setOpen', args: [open] }] })).ok,
    ).toBe(true)
    flush()
    await settle()
  }

  expect(container.textContent).toContain('2 calls')
  await setOpen(/^Codemode #call-1:/, true)
  expect(container.textContent).toContain('Calls · 2')
  expect(container.textContent).toContain('ultimate.entries')
  expect(container.textContent).toContain('ultimate.search')
  expect([...container.querySelectorAll('pre')].map((pre) => pre.textContent)).toContain(
    'Loaded two notes',
  )
  await expectDistinctAgentNames(agent)

  const tree = container.querySelector('button[aria-label^="Inspect Returned value of call "]')
  const returned = () => document.getElementById(tree?.getAttribute('aria-controls') ?? '')
  await setOpen(/^Inspect Returned value of call /, false)
  expect(tree?.getAttribute('aria-expanded')).toBe('false')
  expect(returned()).toBeNull()
  await setOpen(/^Inspect Returned value of call /, true)
  expect(tree?.getAttribute('aria-expanded')).toBe('true')
  expect(returned()?.textContent).toContain('total: 2')
})
