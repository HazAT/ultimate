import { settle } from '@ui-sdk/core/testing'
import { createAgent } from '@ui-sdk/solid/agent'
import { flush } from 'solid-js'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { expectDistinctAgentNames } from '../../../../test/web/agent-names.ts'
import { FakeSource, fakeSubscriptions } from '../../../../test/web/fake-source.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { GoalCall } from '../../call.solid.tsx'
import { StartedCard } from '../../cards.solid.tsx'
import { HandsOff } from '../../chip.solid.tsx'
import { GoalDialog, goalDialog } from '../../dialog.solid.tsx'
import { GoalDoc } from '../../refs.ts'
import type { Goal } from '../../refs.ts'
import type { EntryRecord, ToolCallView } from '@/sdk/solid'

const harness = vi.hoisted(() => ({
  sources: [] as FakeSource[],
  action: vi.fn<(path: string, args: unknown, source: string | null) => void>(),
}))
vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createApi } = await import('../../../../web/src/sdk/api.ts')
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  const { createRegistry } = await import('../../../../web/src/sdk/registry.ts')
  const server = fakeSubscriptions(harness.sources)
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = input as string
    const subscription = server.handle(path, init)
    if (subscription) return subscription
    const { args } = JSON.parse(init!.body as string) as { args: unknown }
    harness.action(path, args, new Headers(init?.headers).get('x-ultimate-source'))
    return Response.json({
      result: path === '/api/extensions/subagents/actions/standing' ? 42 : goal,
    })
  }
  const store = createStore({
    eventSource: (url) => {
      const source = new FakeSource(url)
      harness.sources.push(source)
      return source
    },
    fetch,
  })
  return {
    api: createApi(store, { fetch }),
    store,
    uiState: createUiState(undefined),
    registry: createRegistry(),
    server,
  }
})

import * as client from '../../../../web/src/sdk/client.ts'
import { shellKeys } from '../../../../web/src/sdk/actions.ts'

const { store, uiState, server } = client as typeof client & {
  server: ReturnType<typeof fakeSubscriptions>
}
let approved = true
const agent = createAgent({ allow: (step) => !step.confirm || approved })
const label = 'Go hands-off'
const field = 'The goal'
const goal: Goal = {
  id: 1,
  text: 'Load the sidebar quickly',
  startedAt: 0,
  criteria: [],
  decisions: [],
}
const control = (name: string) =>
  agent.snapshot().find((entry) => !entry.offPage && entry.label === name)

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }))
  harness.action.mockClear()
  uiState.set('ext.goal.draft', '')
  store.setUi({ dialogs: {} })
  store.start()
  harness.sources.at(-1)!.open()
})
afterEach(() => {
  approved = true
  store.stop()
  vi.unstubAllGlobals()
})

async function publish(...goals: Goal[]) {
  server.of(1)!.send('doc', { kind: GoalDoc.kind, value: { next: 2, goals } })
  flush()
  await settle()
}

async function openDialog() {
  const view = renderSolid(() => <GoalDialog />)
  store.setUi({ dialogs: { [goalDialog]: true } })
  flush()
  await settle()
  await publish()
  return view
}

it('asks the person before an agent hands decisions to @ultimate', async () => {
  await openDialog()
  approved = false
  const refused = await agent.act({
    steps: [
      { ref: control(field)!.ref, action: 'setValue', args: [goal.text] },
      { ref: control(label)!.ref, action: 'press' },
    ],
  })
  approved = true
  expect(refused.ok).toBe(false)
  expect(harness.action).not.toHaveBeenCalled()
})

it('starts the goal an agent enters, closes the dialog, and opens @ultimate as that agent', async ({
  onTestFinished,
}) => {
  const view = await openDialog()
  await expectDistinctAgentNames(agent)
  const changes = vi.fn<Parameters<typeof agent.subscribe>[0]>()
  onTestFinished(agent.subscribe(changes))
  const result = await agent.act({
    steps: [
      { ref: control(field)!.ref, action: 'setValue', args: [goal.text] },
      { ref: control(label)!.ref, action: 'press' },
    ],
  })
  expect(result).toMatchObject({ ok: true })
  flush()
  await settle()
  expect(changes).toHaveBeenCalledWith(
    expect.objectContaining({ label: field, value: goal.text, source: 'agent' }),
  )
  expect(harness.action.mock.calls).toEqual([
    ['/api/extensions/goal/actions/start', { text: goal.text }, 'agent'],
    ['/api/extensions/subagents/actions/standing', { name: 'ultimate' }, 'agent'],
  ])
  expect(view.querySelector('[data-goal-dialog][data-open]')).toBeNull()
  expect(uiState.get(shellKeys.conversation)).toBe(42)
  expect(uiState.get(shellKeys.surface)).toBe('agent')
})

it('blocks starting when an open goal arrives even after a draft has been filled', async () => {
  const view = await openDialog()
  expect(
    (
      await agent.act({
        steps: [{ ref: control(field)!.ref, action: 'setValue', args: [goal.text] }],
      })
    ).ok,
  ).toBe(true)
  expect(control(label)?.disabled).not.toBe(true)
  await publish(goal)
  await expectDistinctAgentNames(agent)
  expect(control(label)?.disabled).toBe(true)
  expect(view.querySelector('[data-goal-blocked]')?.textContent).toContain('Goal 1 is still open.')
  expect(harness.action).not.toHaveBeenCalled()
})

it('ends hands-off from the transcript only after the person approves the agent press', async () => {
  const entry = {
    kind: 'goal.started',
    id: 10,
    conversationId: 42,
    data: { goal: goal.id },
  } as unknown as EntryRecord
  const view = renderSolid(() => <StartedCard entry={entry} />)
  await settle()
  await publish(goal)
  await expectDistinctAgentNames(agent)
  const button = control('End hands-off')!
  expect(button.confirm).toBe('Ends the hands-off goal and returns decisions to you.')
  const press = () => agent.act({ steps: [{ ref: button.ref, action: 'press' }] })

  approved = false
  expect((await press()).ok).toBe(false)
  expect(harness.action).not.toHaveBeenCalled()
  approved = true
  expect((await press()).ok).toBe(true)
  expect(harness.action.mock.calls).toEqual([['/api/extensions/goal/actions/end', null, 'agent']])
  await publish({ ...goal, ended: { at: 1, by: 'user', outcome: 'ended' } })
  expect(view.querySelector('[data-goal-end]')).toBeNull()
  expect(view.textContent).toContain('report below')
})

async function proposal() {
  const call = {
    id: 'c1',
    name: 'goal',
    args: { action: 'propose', text: goal.text },
    status: 'done',
    output: '',
    images: [],
    diagnostics: [],
  } as unknown as ToolCallView
  const view = renderSolid(() => <GoalCall call={call} core={null} />)
  await settle()
  await publish()
  return view
}
const proposedStart = 'Start this goal (call c1)'

it('starts a proposed goal with the text the person edited', async () => {
  const view = await proposal()
  await expectDistinctAgentNames(agent)
  const text = view.querySelector<HTMLTextAreaElement>('[data-goal-proposal-text] textarea')!
  expect(text.value).toBe(goal.text)
  text.setRangeText(' by 8:00', text.value.length, text.value.length)
  text.dispatchEvent(new Event('input', { bubbles: true }))
  flush()
  view.querySelector<HTMLButtonElement>('[data-goal-proposal-start]')!.click()
  await settle()
  expect(harness.action.mock.calls[0]).toEqual([
    '/api/extensions/goal/actions/start',
    { text: `${goal.text} by 8:00`, proposal: 'c1' },
    'person',
  ])
  await publish({ ...goal, proposal: 'c1' })
  expect(view.querySelector('[data-goal-proposal-started]')?.textContent).toContain('goal 1')
  expect(view.querySelector('[data-goal-proposal-start]')).toBeNull()
})

it('refuses an agent pressing Start on a proposed goal without the person', async () => {
  await proposal()
  expect(control(proposedStart)!.confirm).toBe('Hands decisions to @ultimate until the goal ends.')
  approved = false
  const refused = await agent.act({
    steps: [{ ref: control(proposedStart)!.ref, action: 'press' }],
  })
  expect(refused.ok).toBe(false)
  expect(harness.action).not.toHaveBeenCalled()
})

it('shows the open goal in the status chip popover and ends it from there', async () => {
  const view = renderSolid(() => <HandsOff />)
  await settle()
  const chip = `Hands-off goal: ${goal.text}`
  expect(control(chip)).toBeUndefined()
  const decision = (picked: string) => ({
    at: 0,
    question: 'Which?',
    picked,
    reason: `${picked} fits`,
  })
  await publish({
    ...goal,
    criteria: [
      { text: 'Loads in 100 ms', status: 'met' },
      { text: 'No layout shift', status: 'blocked', tries: 3 },
    ],
    decisions: [decision('first'), decision('second'), decision('third')],
  })
  expect(
    (await agent.act({ steps: [{ ref: control(chip)!.ref, action: 'setOpen', args: [true] }] })).ok,
  ).toBe(true)
  await settle()
  await expectDistinctAgentNames(agent)
  const popover = view.ownerDocument.querySelector('[data-goal-popover]')!
  expect(
    [...popover.querySelectorAll('[data-goal-criterion]')].map((item) =>
      item.getAttribute('data-goal-criterion'),
    ),
  ).toEqual(['met', 'blocked'])
  const blocked = popover.querySelector('[data-goal-criterion="blocked"]')!
  expect(blocked.querySelector('.sr-only')?.textContent).toBe('blocked: ')
  expect(blocked.textContent).toContain('No layout shift blocked after 3 failed attempts')
  expect(
    [...popover.querySelectorAll('[data-goal-decision]')].map((item) => item.textContent),
  ).toEqual([
    expect.stringContaining('third · third fits'),
    expect.stringContaining('second · second fits'),
  ])
  expect(popover.textContent).toContain('3 decisions taken')

  const end = control('End the hands-off goal')!
  expect(end.confirm).toBe('Ends the hands-off goal and returns decisions to you.')
  expect((await agent.act({ steps: [{ ref: end.ref, action: 'press' }] })).ok).toBe(true)
  expect(harness.action.mock.calls).toEqual([['/api/extensions/goal/actions/end', null, 'agent']])
  await publish({ ...goal, ended: { at: 1, by: 'user', outcome: 'ended' } })
  expect(control(chip)).toBeUndefined()
})

it('submits through the button when the person presses Ctrl+Enter in the goal field', async () => {
  const view = await openDialog()
  const text = view.querySelector<HTMLTextAreaElement>('textarea')!
  text.setRangeText(goal.text)
  text.dispatchEvent(new Event('input', { bubbles: true }))
  flush()
  text.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }),
  )
  await settle()
  expect(harness.action).toHaveBeenCalledWith(
    '/api/extensions/goal/actions/start',
    { text: goal.text },
    'person',
  )
})
