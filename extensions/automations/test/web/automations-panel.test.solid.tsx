/** @jsxImportSource @solidjs/web */
import { createAgent } from '@ui-sdk/solid/agent'
import { settle } from '@ui-sdk/core/testing'
import { flush } from 'solid-js'
import { beforeEach, expect, it, vi } from 'vitest'
import { events, ExtensionName } from '@/sdk/solid'
import { parseConversationId } from '../../../../lib/ids.ts'
import { SOURCE_HEADER, UI_REVISION } from '../../../../shared/protocol.ts'
import type { UiUpdateRequest } from '../../../../shared/protocol.ts'
import { expectDistinctAgentNames } from '../../../../test/web/agent-names.ts'
import { FakeSource, fakeSubscriptions } from '../../../../test/web/fake-source.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { ROOT } from '../../../../web/src/sdk/api.ts'
import { reads, store, uiState } from '../../../../web/src/sdk/client.ts'
import { Chip } from '../../chip.solid.tsx'
import { contextCondition } from '../../form-draft.ts'
import { AutomationsPanel } from '../../panel.solid.tsx'
import type { AutomationListItem } from '../../refs.ts'

const harness = vi.hoisted(() => ({
  sources: [] as FakeSource[],
  server: undefined as ReturnType<typeof fakeSubscriptions> | undefined,
  list: [] as AutomationListItem[],
  actions: [] as { name: string; args: unknown; source: string | null }[],
  writes: [] as { key: string; value: unknown; source: string | null }[],
  confirm: false,
  listReads: 0,
  revision: 0,
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
  'Deletes Morning reports (A1). Future runs stop. Its conversations and files are kept.'

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
      return Response.json({ ok: true, rev: ++harness.revision })
    }
    if (path.endsWith('/subagents/actions/definitions'))
      return Response.json({
        result: {
          definitions: [
            {
              name: 'reviewer',
              description: 'Review the work',
              path: '/agents/reviewer.md',
              source: 'builtin',
            },
          ],
        },
      })
    const action = /^\/api\/extensions\/automations\/actions\/(\w+)$/.exec(path)?.[1]
    switch (action) {
      case 'list':
        harness.listReads++
        return Response.json({ result: harness.list })
      case 'describe':
        return Response.json({
          result: { description: 'Every 15 minutes', schedule: reports.schedule, next: [] },
        })
      case 'log':
        return Response.json({
          result: { text: 'checking \x1b]52;c;hidden payload\x07<img src=x>\nFIRE build green' },
        })
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
  const { answerReadsWith } = await import('../../../../test/web/fake-source.ts')
  const pageFetch = answerReadsWith(fetch)
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
const panel = () =>
  renderSolid(() => (
    <ExtensionName value="automations">
      <AutomationsPanel />
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
  uiState.receive({ [UI_REVISION]: ++harness.revision })
  harness.writes.length = 0
  store.show(undefined)
  store.start()
  harness.sources.at(-1)!.open()
  onTestFinished(() => {
    store.stop()
    vi.unstubAllGlobals()
  })
})

it('pauses, runs, and requires a person’s confirmation before deleting', async () => {
  const view = panel()
  await settle()
  await expectDistinctAgentNames(agent)
  expect((await act('Enable Morning reports (A1)', 'setChecked', false)).ok).toBe(true)
  await settle()
  expect(harness.actions).toEqual([{ name: 'pause', args: { id: 'A1' }, source: 'agent' }])
  expect(control('Enable Morning reports (A1)')).toMatchObject({ checked: false })

  expect((await act('Actions for Morning reports (A1)', 'press', 'Run now')).ok).toBe(true)
  expect(harness.actions.at(-1)).toEqual({ name: 'run', args: { id: 'A1' }, source: 'agent' })
  await settle()
  expect(view.textContent).toContain('No runs yet')

  await uiState.flush()
  expect(uiState.get('ext.automations.expanded')).toEqual(['A1'])
  expect((await act('Actions for Morning reports (A1)', 'press', 'Delete…')).ok).toBe(true)
  expect(control('Delete Morning reports (A1)').confirm).toBe(confirmation)
  expect((await act('Delete Morning reports (A1)', 'press')).ok).toBe(false)
  expect(allow).toHaveBeenCalledWith(
    expect.objectContaining({ confirm: confirmation }),
    expect.anything(),
  )
  expect(harness.actions.map(({ name }) => name)).toEqual(['pause', 'run'])
  harness.confirm = true
  expect((await act('Delete Morning reports (A1)', 'press')).ok).toBe(true)
  await settle()
  await uiState.flush()
  expect(harness.actions.at(-1)).toEqual({ name: 'delete', args: { id: 'A1' }, source: 'agent' })
  expect(harness.writes.at(-1)).toEqual({
    key: 'ext.automations.expanded',
    value: [],
    source: 'agent',
  })
  expect(view.querySelector('[data-automation="A1"]')).toBeNull()
})

it('distinguishes the controls of two same-named automations, including delete confirmation', async () => {
  harness.list = [reports, { ...checks, name: reports.name }]
  panel()
  await settle()
  for (const id of ['A1', 'A2']) {
    expect((await act(`Run history for Morning reports (${id})`, 'setOpen', true)).ok).toBe(true)
    expect((await act(`Actions for Morning reports (${id})`, 'press', 'Delete…')).ok).toBe(true)
    expect(control(`Delete Morning reports (${id})`).confirm).toContain(`(${id})`)
  }
  await expectDistinctAgentNames(agent)
})

it('creates an automation through the form as the agent', async () => {
  panel()
  await settle()
  expect((await act('Add an automation', 'press')).ok).toBe(true)
  await settle()
  await expectDistinctAgentNames(agent)
  expect((await act('Name', 'setValue', 'Lunch summary')).ok).toBe(true)
  expect((await act('Prompt', 'setValue', 'Summarise open questions.')).ok).toBe(true)
  expect((await act('Hourly', 'setPressed', true)).ok).toBe(true)
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

it('suspends the editor for a definition and restores the draft and Configure focus', async ({
  onTestFinished,
}) => {
  harness.list = [{ ...reports, agent: 'reviewer' }]
  const view = panel()
  await settle()
  expect((await act('Actions for Morning reports (A1)', 'press', 'Edit')).ok).toBe(true)
  expect((await act('Name', 'setValue', 'Unsubmitted name')).ok).toBe(true)
  expect((await act('Prompt', 'setValue', 'Unsubmitted prompt')).ok).toBe(true)
  const dialog = () => view.querySelector('[data-slot="dialog-content"]')
  const opened: { data: unknown; editorOpen?: boolean }[] = []
  onTestFinished(
    events.on('subagents:open-definition', (data) => {
      opened.push({ data, editorOpen: dialog()?.hasAttribute('data-open') })
    }),
  )
  expect((await act('Configure', 'press')).ok).toBe(true)
  await settle()
  expect(opened).toEqual([{ data: { name: 'reviewer' }, editorOpen: false }])
  events.emit('subagents:definition-closed', { name: 'reviewer' })
  await settle()
  expect(control('Name').value).toBe('Unsubmitted name')
  expect(control('Prompt').value).toBe('Unsubmitted prompt')
  expect(document.activeElement).toBe(view.querySelector('[data-automation-configure]'))
})

it('refreshes an overdue automation while the panel is hidden', async ({ onTestFinished }) => {
  vi.useFakeTimers()
  onTestFinished(() => {
    vi.useRealTimers()
  })
  harness.list = [{ ...reports, nextAt: Date.now() - 5000 }]
  panel()
  await vi.advanceTimersByTimeAsync(0)
  const before = harness.listReads
  await vi.advanceTimersByTimeAsync(2500)
  expect(harness.listReads).toBe(before + 1)
  expect(harness.server!.reads.filter((read) => !read.closed)).toContainEqual(
    expect.objectContaining({ read: expect.objectContaining({ action: 'list' }), every: 2000 }),
  )
})

it('persists which run history is expanded', async () => {
  const view = panel()
  await settle()
  expect(view.textContent).not.toContain('No runs yet')
  expect((await act('Run history for Morning reports (A1)', 'setOpen', true)).ok).toBe(true)
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
  const view = panel()
  store.show(watcher)
  await settle()
  const detail = view.querySelector('[data-automation-script="A2"]')!
  expect(detail.textContent).toContain('FIRE build green')
  expect(detail.textContent).toContain('<img src=x>')
  expect(detail.textContent).not.toContain('hidden payload')
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
  await reads.get('automations', 'list', null, ROOT).refetch()
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
