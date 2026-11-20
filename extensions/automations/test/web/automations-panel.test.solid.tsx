/** @jsxImportSource @solidjs/web */
import { createAgent } from '@ui-sdk/solid/agent'
import { settle } from '@ui-sdk/core/testing'
import { flush } from 'solid-js'
import { beforeEach, expect, it, vi } from 'vitest'
import { ExtensionName } from '@/sdk/solid'
import { parseConversationId } from '../../../../lib/ids.ts'
import { SOURCE_HEADER, UI_REVISION } from '../../../../shared/protocol.ts'
import type { UiUpdateRequest } from '../../../../shared/protocol.ts'
import { expectDistinctAgentNames } from '../../../../test/web/agent-names.ts'
import { FakeSource, fakeSubscriptions } from '../../../../test/web/fake-source.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { store, uiState } from '../../../../web/src/sdk/client.ts'
import { Chip } from '../../chip.solid.tsx'
import { contextCondition } from '../../form-draft.ts'
import { AutomationsPanel } from '../../panel.solid.tsx'
import type { AutomationListItem } from '../../refs.ts'
import { refreshList } from '../../live.solid.tsx'

const harness = vi.hoisted(() => ({
  sources: [] as FakeSource[],
  server: undefined as ReturnType<typeof fakeSubscriptions> | undefined,
  list: [] as AutomationListItem[],
  actions: [] as { name: string; args: unknown; source: string | null }[],
  writes: [] as { key: string; value: unknown; source: string | null }[],
  confirm: false,
}))

const reports: AutomationListItem = {
  id: 'A1',
  name: 'Morning reports',
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
  schedule: { kind: 'every', ms: 900_000 },
  prompt: 'Check the reports.',
  subscribers: [],
  runs: [],
  fires: 0,
  alive: false,
}
const watcher = parseConversationId(42)
const checks: AutomationListItem = {
  ...reports,
  id: 'A2',
  name: 'Watch checks',
  schedule: undefined,
  prompt: undefined,
  alive: true,
  script: { ask: 'Watch CI', once: false, conversationId: watcher, state: 'running' },
}
const confirmation =
  'Deletes Morning reports. Future runs stop. Its conversations and files are kept.'

vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createApi } = await import('../../../../web/src/sdk/api.ts')
  const { createReads } = await import('../../../../web/src/sdk/reads.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  const { createRegistry } = await import('../../../../web/src/sdk/registry.ts')
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const source = new Headers(init?.headers).get(SOURCE_HEADER)
    if (path === '/api/ui') {
      const { ops } = JSON.parse(init!.body as string) as UiUpdateRequest
      for (const { key, value } of ops) harness.writes.push({ key, value, source })
      return Response.json({ ok: true, rev: 1 })
    }
    if (path.endsWith('/subagents/actions/definitions'))
      return Response.json({ result: { definitions: [] } })
    const action = /^\/api\/extensions\/automations\/actions\/(\w+)$/.exec(path)?.[1]
    switch (action) {
      case 'list':
        return Response.json({ result: harness.list })
      case 'describe':
        return Response.json({
          result: { description: 'Every 15 minutes', schedule: reports.schedule, next: [] },
        })
      case 'log':
        return Response.json({ result: { text: 'checking <img src=x>\nFIRE build green' } })
      case 'script':
        return Response.json({
          result: { path: '/automations/A2/run', text: '#!/bin/sh\necho OK' },
        })
      case 'pause':
      case 'run':
      case 'delete':
      case 'create': {
        const { args } = JSON.parse(init!.body as string)
        harness.actions.push({ name: action, args, source })
        if (action === 'pause')
          harness.list = harness.list.map((item) =>
            item.id === args.id ? { ...item, enabled: false } : item,
          )
        if (action === 'delete') harness.list = harness.list.filter((item) => item.id !== args.id)
        return Response.json({ result: reports })
      }
      default:
        return harness.server?.handle(path, init) ?? Response.json({ ok: true })
    }
  }
  const clientStore = createStore({
    eventSource: (url) => {
      const stream = new FakeSource(url)
      harness.sources.push(stream)
      return stream
    },
    fetch,
  })
  const api = createApi(clientStore, { fetch })
  return {
    store: clientStore,
    api,
    reads: createReads(api, clientStore),
    registry: createRegistry(),
    uiState: createUiState(api.updateUi),
  }
})

const allow = vi.fn<NonNullable<NonNullable<Parameters<typeof createAgent>[0]>['allow']>>(
  (step) => !step.confirm || (harness.confirm && step.confirm === confirmation),
)
const agent = createAgent({ allow })
harness.server = fakeSubscriptions(harness.sources)

const control = (label: string) => {
  const entry = agent.snapshot().find((item) => !item.offPage && item.label === label)
  expect(entry).toBeDefined()
  return entry!
}
const act = (label: string, action: string, ...args: unknown[]) =>
  agent.act({ steps: [{ ref: control(label).ref, action, args }] })
const panel = (requested?: typeof watcher) =>
  renderSolid(() => (
    <ExtensionName value="automations">
      <AutomationsPanel overlayOpen={false} requested={requested} />
    </ExtensionName>
  ))

beforeEach(async ({ onTestFinished }) => {
  harness.list = [reports, checks]
  harness.actions.length = 0
  harness.writes.length = 0
  harness.confirm = false
  allow.mockClear()
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }))
  await uiState.flush()
  uiState.receive({ [UI_REVISION]: 1 })
  harness.writes.length = 0
  store.start()
  harness.sources.at(-1)!.open()
  onTestFinished(() => {
    store.stop()
    vi.unstubAllGlobals()
  })
  await refreshList()
})

it('pauses, runs, and requires a person’s confirmation before deleting', async () => {
  const view = panel()
  await settle()
  await expectDistinctAgentNames(agent)
  expect((await act('Enable Morning reports', 'setChecked', false)).ok).toBe(true)
  await settle()
  expect(harness.actions).toEqual([{ name: 'pause', args: { id: 'A1' }, source: 'agent' }])
  expect(control('Enable Morning reports')).toMatchObject({ checked: false })

  expect((await act('Actions for Morning reports', 'press', 'Run now')).ok).toBe(true)
  expect(harness.actions.at(-1)).toEqual({ name: 'run', args: { id: 'A1' }, source: 'agent' })
  await settle()
  expect(view.textContent).toContain('No runs yet')

  expect((await act('Actions for Morning reports', 'press', 'Delete…')).ok).toBe(true)
  expect(control('Delete Morning reports').confirm).toBe(confirmation)
  expect((await act('Delete Morning reports', 'press')).ok).toBe(false)
  expect(allow).toHaveBeenCalledWith(
    expect.objectContaining({ confirm: confirmation }),
    expect.anything(),
  )
  expect(harness.actions.map(({ name }) => name)).toEqual(['pause', 'run'])
  harness.confirm = true
  expect((await act('Delete Morning reports', 'press')).ok).toBe(true)
  await settle()
  expect(harness.actions.at(-1)).toEqual({ name: 'delete', args: { id: 'A1' }, source: 'agent' })
  expect(view.querySelector('[data-automation="A1"]')).toBeNull()
})

it('creates an automation through the form as the agent', async () => {
  panel()
  await settle()
  expect((await act('Add an automation', 'press')).ok).toBe(true)
  await settle()
  await expectDistinctAgentNames(agent)
  expect((await act('Name', 'setValue', 'Lunch summary')).ok).toBe(true)
  expect((await act('Prompt', 'setValue', 'Summarise open questions.')).ok).toBe(true)
  expect((await act('Hourly', 'press')).ok).toBe(true)
  expect((await act('Interval length', 'setValue', '2h')).ok).toBe(true)
  expect((await act('Create', 'press')).ok).toBe(true)
  expect(harness.actions).toEqual([
    {
      name: 'create',
      source: 'agent',
      args: {
        name: 'Lunch summary',
        prompt: 'Summarise open questions.',
        schedule: 'every 2h',
      },
    },
  ])
})

it('persists which run history is expanded', async () => {
  const view = panel()
  await settle()
  expect(view.textContent).not.toContain('No runs yet')
  expect((await act('Run history for Morning reports', 'setOpen', true)).ok).toBe(true)
  flush()
  expect(view.textContent).toContain('No runs yet')
  await uiState.flush()
  expect(harness.writes).toContainEqual({
    key: 'ext.automations.expanded',
    value: ['A1'],
    source: 'agent',
  })
})

it('shows watcher output and safely switches to its durable source pane', async () => {
  const view = panel(watcher)
  await settle()
  const detail = view.querySelector('[data-automation-script="A2"]')!
  expect(detail.textContent).toContain('FIRE build green')
  expect(detail.textContent).toContain('<img src=x>')
  expect(detail.querySelector('img')).toBeNull()
  expect(detail.textContent).toContain('/automations/A2/run')
  expect((await act('Watcher pane', 'setValue', 'script')).ok).toBe(true)
  flush()
  expect(detail.querySelector('pre code')?.textContent).toContain('2echo OK')
  await uiState.flush()
  expect(harness.writes).toContainEqual({
    key: 'ext.automations.pane',
    value: 'script',
    source: 'agent',
  })
  expect((await act('Back to automation list', 'press')).ok).toBe(true)
  flush()
  expect(view.querySelector('[data-automation="A2"]')).not.toBeNull()
})

it('shows the active count and opens Automations from the chip', async () => {
  const view = renderSolid(() => <Chip />)
  await settle()
  expect(view.textContent).toContain('2 automations')
  expect((await act('2 active: show Automations panel', 'press')).ok).toBe(true)
  await uiState.flush()
  expect(harness.writes).toContainEqual({
    key: 'shell.panel',
    value: 'automations',
    source: 'agent',
  })
  harness.list = []
  await refreshList()
  flush()
  expect(view.querySelector('[data-automations-chip]')).toBeNull()
})

it('rejects a cleared context number instead of using zero', () => {
  const draft = { of: '@ultimate', above: '80', cooldownMinutes: '15', idleHours: '0' }
  expect(contextCondition(draft)).toMatchObject({ above: 80, cooldownMs: 900000, idleFor: 0 })
  expect(contextCondition({ ...draft, cooldownMinutes: '' })).toBeUndefined()
  expect(contextCondition({ ...draft, above: ' ' })).toBeUndefined()
  expect(contextCondition({ ...draft, idleHours: '' })).toBeUndefined()
})
