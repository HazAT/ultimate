/** @jsxImportSource @solidjs/web */
import { settle } from '@ui-sdk/core/testing'
import { createAgent } from '@ui-sdk/solid/agent'
import { flush } from 'solid-js'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { expectDistinctAgentNames } from '../../../../test/web/agent-names.ts'
import { FakeSource, fakeSubscriptions } from '../../../../test/web/fake-source.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { StartedCard } from '../../cards.solid.tsx'
import { HandsOff } from '../../chip.solid.tsx'
import { GoalDialog, goalDialog } from '../../dialog.solid.tsx'
import { GoalDoc } from '../../refs.ts'
import type { Goal } from '../../refs.ts'
import type { EntryRecord } from '@/sdk'

const harness = vi.hoisted(() => ({
  sources: [] as FakeSource[],
  action: vi.fn<(path: string, args: unknown, source: string | null) => void>(),
}))
vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createApi } = await import('../../../../web/src/sdk/api.ts')
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
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
  return { api: createApi(store, { fetch }), store, uiState: createUiState(undefined), server }
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

it('shows the status chip only for an open goal', async () => {
  renderSolid(() => <HandsOff />)
  await settle()
  const chip = `Hands-off goal: ${goal.text}`
  expect(control(chip)).toBeUndefined()
  await publish(goal)
  expect(control(chip)).toMatchObject({ component: 'button', actions: ['press'] })
  await expectDistinctAgentNames(agent)
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
