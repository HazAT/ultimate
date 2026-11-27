import type { TaskGraphNode } from '@earendil-works/pi-durable'
import { settle } from '@ui-sdk/core/testing'
import { createAgent } from '@ui-sdk/solid/agent'
import { flush } from 'solid-js'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { parseConversationId, parseTaskId } from '../../../../lib/ids.shared.ts'
import type { UiUpdateRequest } from '../../../../shared/protocol.ts'
import { expectDistinctAgentNames } from '../../../../test/web/agent-names.ts'
import { FakeSource, fakeSubscriptions } from '../../../../test/web/fake-source.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { OverviewDoc } from '../../../conversations/refs.ts'
import { TaskIndexDoc } from '../../../plan/refs.ts'
import { WorkspacesDoc } from '../../../workspaces/refs.ts'

const harness = vi.hoisted(() => ({
  sources: [] as FakeSource[],
  calls: [] as Array<{ action: string; ids: number[] }>,
  writes: [] as UiUpdateRequest['ops'],
  fail: false,
  hold: undefined as (() => Promise<void>) | undefined,
}))
vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createApi } = await import('../../../../web/src/sdk/api.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  const { createRegistry } = await import('../../../../web/src/sdk/registry.ts')
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = input as string
    const action = /^\/api\/extensions\/tasks\/actions\/(\w+)$/.exec(path)?.[1]
    if (!action) return subscriptions.handle(path, init) ?? Response.json({ ok: true })
    const {
      args: { ids },
    } = JSON.parse(init!.body as string) as { args: { ids: number[] } }
    harness.calls.push({ action, ids })
    const fail = harness.fail
    await harness.hold?.()
    if (fail) return Response.json({ error: 'server restarting' }, { status: 503 })
    const facts = action === 'describe' && ids.includes(8) ? { 8: { tool: 'Inspect' } } : {}
    return Response.json({ result: facts })
  }
  const store = createStore({
    eventSource: (url) => {
      const stream = new FakeSource(url)
      harness.sources.push(stream)
      return stream
    },
    fetch,
  })
  const uiState = createUiState(async ({ ops }) => {
    harness.writes.push(...ops)
    return { ok: true, rev: 1 }
  })
  return { store, api: createApi(store, { fetch }), uiState, registry: createRegistry() }
})

import { registry, store, uiState } from '../../../../web/src/sdk/client.ts'
import plan from '../../../plan/web.solid.tsx'
import { TasksPanel } from '../../panel.solid.tsx'

const agent = createAgent()
const subscriptions = fakeSubscriptions(harness.sources)
const root = parseConversationId(1)
const child = parseConversationId(3)
const stream = () => harness.sources.at(-1)!
const task = (id: number, overrides: Partial<TaskGraphNode> = {}): TaskGraphNode => ({
  id: parseTaskId(id),
  kind: 'pi.generation',
  conversationId: root,
  background: false,
  abortRequested: false,
  state: { status: 'running', phase: 'stream' },
  conversations: [],
  ...overrides,
})
const sendTasks = (...tasks: TaskGraphNode[]) => {
  stream().send('tasks', { tasks: Object.fromEntries(tasks.map((row) => [row.id, row])) })
  flush()
}
const live = (label: string) =>
  agent.snapshot().find((entry) => !entry.offPage && entry.label === label)

beforeEach(() => {
  harness.calls.length = 0
  harness.writes.length = 0
  harness.fail = false
  harness.hold = undefined
  store.start()
  stream().open()
  store.show(root)
  sendTasks()
})
afterEach(() => {
  store.stop()
  vi.unstubAllGlobals()
})

it('keeps a blocked background task and its reason visible while folding ordinary work', async ({
  onTestFinished,
}) => {
  const blocked = task(7, { kind: 'blocked-chore', blocked: 'missing_task' })
  const routine = task(8, { kind: 'routine-chore' })
  sendTasks(blocked, routine)
  const panel = renderSolid(() => <TasksPanel />)
  expect(panel.textContent).toContain('blocked · missing task')
  expect(panel.querySelector('[data-graph-task="7"] svg[aria-label="interrupted"]')).not.toBeNull()
  expect(panel.textContent).not.toContain('routine-chore')
  const changes = vi.fn<Parameters<typeof agent.subscribe>[0]>()
  onTestFinished(agent.subscribe(changes))
  const trigger = live('Background tasks')
  const result = await agent.act({
    steps: [{ ref: trigger!.ref, action: 'setOpen', args: [true] }],
  })
  expect(result.ok).toBe(true)
  flush()
  expect(panel.textContent).toContain('routine-chore')
  expect(panel.textContent).toContain('blocked · missing task')
  expect(changes).toHaveBeenCalledWith(
    expect.objectContaining({ key: 'open', value: true, source: 'agent' }),
  )
})

it('continues a rail past a nested child only when its ancestor has a following sibling', async () => {
  const parent = task(7)
  const first = task(8, { kind: 'pi.tool', owner: parent.id })
  const last = task(9, { owner: parent.id })
  const nested = task(10, { owner: first.id })
  sendTasks(parent, first, last)
  const panel = renderSolid(() => <TasksPanel />)
  await settle()
  flush()
  expect(panel.querySelector('[data-graph-task="8"]')?.textContent).toContain('Inspect')
  sendTasks(parent, first, last, nested)
  await settle()
  flush()
  const rows = [...panel.querySelectorAll('[data-graph-task]')]
  expect(rows.map((row) => row.getAttribute('data-graph-task'))).toEqual(['7', '8', '10', '9'])
  expect(
    rows.map((row) =>
      [...row.querySelectorAll('[data-rail]')].map((line) => line.getAttribute('data-rail')),
    ),
  ).toEqual([[], ['next'], ['rail', 'last'], ['last']])
  expect(rows.map((row) => row.querySelectorAll('[data-elbow]').length)).toEqual([0, 1, 1, 1])
  expect(
    harness.calls.filter((call) => call.action === 'describe').map((call) => call.ids),
  ).toEqual([[7, 8, 9], [10]])
  expect(harness.calls.filter((call) => call.action === 'started').map((call) => call.ids)).toEqual(
    [[7, 8, 9], [10]],
  )
  expect(rows[1].textContent).toContain('Inspect')
})

it('asks again on the new connection for each batch whose request failed across a reconnect', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const holds: Array<() => void> = []
  harness.hold = () => new Promise((resolve) => holds.push(resolve))
  harness.fail = true
  sendTasks(task(7))
  const panel = renderSolid(() => <TasksPanel />)
  await settle()
  sendTasks(task(7), task(8, { kind: 'pi.tool' }))
  await settle()
  flush()
  stream().drop()
  flush()
  stream().open()
  await settle()
  harness.hold = undefined
  harness.fail = false
  for (const release of holds.splice(0)) {
    release()
    await settle()
    flush()
  }
  const described = harness.calls.filter((call) => call.action === 'describe')
  expect(described.map((call) => call.ids)).toEqual([[7], [8], [7], [8]])
  expect(panel.querySelector('[data-graph-task="8"]')?.textContent).toContain('Inspect')
})

it('lets an agent open the conversation without opening its linked plan task', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }))
  await registry.setLoaders({ 'extensions/plan/web.solid.tsx': async () => ({ default: plan }) })
  stream().send('conversations', [{ id: child, busy: true, title: 'Write the guide' }])
  sendTasks(task(7, { conversationId: child }))
  const panel = renderSolid(() => <TasksPanel />)
  await settle()
  const docs = subscriptions.of(root)!
  docs.send('doc', {
    kind: TaskIndexDoc.kind,
    value: {
      children: {
        [child]: {
          coordinator: root,
          epic: 'E1',
          key: 'E1.2',
          title: 'Guide',
          status: 'in_progress',
        },
      },
    },
  })
  docs.send('doc', {
    kind: OverviewDoc.kind,
    value: { conversations: { [child]: { feature: 'Docs', runState: 'working' } } },
  })
  docs.send('doc', {
    kind: WorkspacesDoc.kind,
    value: {
      items: {
        [child]: {
          path: '/workspace',
          branch: 'guide',
          base: 'base',
          source: '/source',
          target: 'main',
          state: 'ready',
        },
      },
      queue: [],
      landers: {},
      landerConversations: {},
      results: {},
    },
  })
  flush()

  const label = 'Open conversation #3: Write the guide'
  const button = panel.querySelector(`button[aria-label="${label}"]`)
  const chip = panel.querySelector('button[data-task="E1.2"]')
  expect(chip).not.toBeNull()
  expect(button?.contains(chip)).toBe(false)
  expect(chip?.closest('[data-current], div')).toBe(button?.parentElement)
  expect(button?.textContent).toContain('#3')
  expect(button?.querySelector('[data-feature="Docs"]')).not.toBeNull()
  expect(button?.querySelector('svg[aria-label="Isolated checkout"]')).not.toBeNull()
  await expectDistinctAgentNames(agent)
  const target = live(label)
  expect(target?.actions).toContain('press')
  const result = await agent.act({ steps: [{ ref: target!.ref, action: 'press' }] })
  expect(result.ok).toBe(true)
  await uiState.flush()
  expect(uiState.get('shell.conversation')).toBe(child)
  expect(harness.writes).toEqual([
    expect.objectContaining({ key: 'shell.conversation', value: child, who: 'agent' }),
  ])
})
