/** @jsxImportSource @solidjs/web */
import { settle } from '@ui-sdk/core/testing'
import { createAgent } from '@ui-sdk/solid/agent'
import { flush } from 'solid-js'
import { beforeEach, expect, it, vi } from 'vitest'
import { ExtensionName } from '@/sdk/solid'
import { SOURCE_HEADER } from '../../../../shared/protocol.ts'
import type { ModelsResponse } from '../../../../shared/protocol.ts'
import { expectDistinctAgentNames } from '../../../../test/web/agent-names.ts'
import { FakeSource, fakeSubscriptions } from '../../../../test/web/fake-source.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { store, uiState } from '../../../../web/src/sdk/client.ts'
import type { FamiliesView } from '../../../models/refs.ts'
import { DefinitionDialog } from '../../definitions.solid.tsx'
import { InstructionsEditor } from '../../fields.solid.tsx'
import { AgentsPanel } from '../../overview.solid.tsx'
import type { Discovery, Shown } from '../../refs.ts'

const harness = vi.hoisted(() => ({
  fetch: vi.fn<typeof fetch>(),
  sources: [] as FakeSource[],
}))
vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createApi } = await import('../../../../web/src/sdk/api.ts')
  const { createReads } = await import('../../../../web/src/sdk/reads.ts')
  const { createRegistry } = await import('../../../../web/src/sdk/registry.ts')
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  const { answerReadsWith } = await import('../../../../test/web/fake-source.ts')
  const pageFetch = answerReadsWith(harness.fetch)
  const clientStore = createStore({
    eventSource: (url) => {
      const stream = new FakeSource(url)
      harness.sources.push(stream)
      return stream
    },
    fetch: pageFetch,
  })
  const api = createApi(clientStore, { fetch: pageFetch })
  return {
    store: clientStore,
    api,
    reads: createReads(api, clientStore),
    registry: createRegistry(),
    uiState: createUiState(undefined),
  }
})

const families: FamiliesView = {
  families: [
    { name: 'default', color: 'sky', builtin: true, follows: 'faux/atlas' },
    { name: 'default-local', color: 'violet', builtin: false },
  ],
  users: [],
  assign: {},
  from: 'builtin',
  errors: [],
}
const discovery: Discovery = {
  definitions: [],
  errors: [],
  main: {
    model: { provider: 'faux', modelId: 'atlas' },
    tools: [{ name: 'read', description: 'Read files' }],
  },
  skills: [{ name: 'read', description: 'Read carefully' }],
  scopes: { user: '/user/agents', project: '/project/agents' },
  projectSetup: 'trusted',
}
const catalog: ModelsResponse = {
  providers: [],
  models: ['atlas', 'orion'].map((id) => ({
    provider: 'faux',
    id,
    name: id,
    contextWindow: 1000,
    maxTokens: 100,
    available: true,
    reasoning: true,
    thinkingLevels: ['off', 'low', 'high'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  })),
}
const created: Shown = {
  source: 'project',
  path: '/project/agents/reviewer.md',
  files: ['project'],
  raw: '# review',
  definition: {
    name: 'reviewer',
    description: 'Review work',
    path: '/project/agents/reviewer.md',
    source: 'project',
    model: { provider: 'faux', modelId: 'orion' },
    instructions: '# review',
  },
}

beforeEach(async () => {
  harness.fetch.mockReset()
  const server = fakeSubscriptions(harness.sources)
  harness.fetch.mockImplementation(async (url, init) => {
    const path = url as string
    const subscription = server.handle(path, init)
    if (subscription) return subscription
    if (path === '/api/models') return Response.json(catalog)
    if (path.endsWith('/families')) return Response.json({ result: families })
    if (path.endsWith('/definitions')) return Response.json({ result: discovery })
    if (path.endsWith('/definition')) return Response.json({ result: created })
    return Response.json({ result: null })
  })
  store.stop()
  store.start()
  harness.sources.at(-1)!.open()
  store.setUi({ dialogs: {} })
  uiState.receive({})
  await store.refreshModels()
})

const agent = createAgent()

it('lets the agent select a visible instructions panel by name', async () => {
  const page = renderSolid(() => <InstructionsEditor value="**A prompt**" onChange={() => {}} />)
  const tabs = agent.snapshot().find((entry) => !entry.offPage && entry.label === 'Prompt view')
  expect(tabs).toMatchObject({ component: 'tabs', value: 'write' })
  expect(
    await agent.act({ steps: [{ ref: tabs!.ref, action: 'setValue', args: ['Preview'] }] }),
  ).toMatchObject({ ok: true })
  expect(page.querySelector('[role="tabpanel"] strong')?.textContent).toBe('A prompt')
})
async function act(label: string, action: string, ...args: unknown[]) {
  const entry = agent.snapshot().find((item) => !item.offPage && item.label === label)
  expect(entry).toBeDefined()
  const result = await agent.act({ steps: [{ ref: entry!.ref, action, args }] })
  flush()
  expect(result).toMatchObject({ ok: true })
}
const writes = (action: string) =>
  harness.fetch.mock.calls.flatMap(([url, init]) =>
    typeof url === 'string' && url.endsWith(`/actions/${action}`)
      ? [
          {
            args: JSON.parse(init!.body as string).args,
            source: new Headers(init?.headers).get(SOURCE_HEADER),
          },
        ]
      : [],
  )
async function openPanel() {
  const container = renderSolid(() => (
    <ExtensionName value="subagents">
      <AgentsPanel />
      <DefinitionDialog />
    </ExtensionName>
  ))
  await settle()
  flush()
  return container
}

it('creates a definition through the agent controls, including the chosen model', async () => {
  const panel = await openPanel()
  await act('New agent definition', 'press')
  await act('Definition identifier', 'setValue', 'reviewer')
  await act('Description', 'setValue', 'Review work')
  await act('Instructions', 'setValue', '# review')
  await act('Pin a model', 'press')
  await act('Choose model for agent definition', 'setOpen', true)
  await expectDistinctAgentNames(agent)
  await act('Search catalog for agent definition', 'run', 'faux/orion')
  await act('Save agent definition', 'press')
  expect(writes('saveDefinition')).toEqual([
    {
      args: {
        name: 'reviewer',
        scope: 'project',
        create: true,
        frontmatter: { description: 'Review work', model: 'faux/orion', resident: false },
        instructions: '# review',
      },
      source: 'agent',
    },
  ])
  expect(panel.querySelector('[data-slot="dialog-title"]')?.textContent).toContain('reviewer')
})

it('edits a family through its popover, saving the chosen model as the agent', async () => {
  const panel = await openPanel()
  await act('Edit default model family', 'setOpen', true)
  await act('Choose model for default family', 'setOpen', true)
  await expectDistinctAgentNames(agent)
  await act('Search catalog for default family', 'run', 'faux/orion')
  await act('Save changes to default family', 'press')
  expect(writes('saveFamilies')).toEqual([
    {
      args: {
        families: {
          default: { model: 'faux/orion', color: 'sky' },
          'default-local': { color: 'violet' },
        },
        assign: {},
        unpin: [],
      },
      source: 'agent',
    },
  ])
  expect(
    panel.querySelector('[aria-label="Edit default model family"]')?.getAttribute('aria-expanded'),
  ).toBe('false')
})
