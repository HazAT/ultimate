/** @jsxImportSource @solidjs/web */
import { expect, it } from 'vitest'
import { parseConversationId } from '../../../../lib/ids.ts'
import type { ConversationSummary } from '../../../../shared/protocol.ts'
import { expectDistinctAgentNames } from '../../../../test/web/agent-names.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import {
  act,
  actions,
  agent,
  approval,
  pause,
  refetchState,
  server,
  state,
  stream,
  tick,
} from './status-harness.ts'
import { Limit } from '../../entries.solid.tsx'
import { PauseDoc } from '../../refs.ts'
import { Item, Play } from '../../status.solid.tsx'
import type { EntryRecord } from '@/sdk'

async function mountStatus() {
  await refetchState()
  const container = renderSolid(() => (
    <>
      <Item />
      <Play />
    </>
  ))
  await tick()
  return container
}

async function openPause() {
  await act('Pause or continue all work', 'setOpen', [true])
  await expectDistinctAgentNames(agent)
}

it('lets an agent open Pause, set auto-play minutes, and pause the host', async () => {
  const container = await mountStatus()
  expect(
    agent
      .snapshot()
      .filter((entry) => !entry.offPage)
      .map((entry) => entry.component),
  ).toEqual(['popover'])
  await openPause()
  expect(container.querySelector('[data-pause-autoplay]')).not.toBeNull()
  approval.given = false
  await act('Auto-play delay in minutes', 'setValue', [45], false)
  expect(actions.filter((call) => call.name === 'autoPlay')).toEqual([])
  approval.given = true
  await act('Auto-play delay in minutes', 'setValue', [45])
  expect(actions).toContainEqual({ name: 'autoPlay', args: { minutes: 45 }, source: 'agent' })
  approval.given = false
  await act('Play by itself after', 'setChecked', [false], false)
  expect(actions.filter((call) => call.name === 'autoPlay')).toHaveLength(1)
  approval.given = true
  await act('Play by itself after', 'setChecked', [false])
  expect(actions).toContainEqual({ name: 'autoPlay', args: { minutes: null }, source: 'agent' })
  await act('Pause: stop starting new work', 'press')
  expect(actions).toContainEqual({ name: 'pause', args: null, source: 'agent' })
  expect(container.querySelector('[data-pause="paused"]')).not.toBeNull()
})

it('lets an agent continue all work from the Play chip only with a person’s approval', async () => {
  const container = await mountStatus()
  pause()
  await tick()
  expect(container.querySelector('[data-pause-play]')).not.toBeNull()
  await openPause()
  approval.given = false
  await act('Play paused work', 'press', undefined, false)
  expect(actions.filter((call) => call.name === 'play')).toEqual([])
  approval.given = true
  await act('Play paused work', 'press')
  expect(actions).toContainEqual({ name: 'play', args: null, source: 'agent' })
  expect(container.querySelector('[data-pause-play]')).toBeNull()
})

it('continues paused work from the popover for an agent only once a person approves', async () => {
  await mountStatus()
  pause()
  await tick()
  await openPause()
  approval.given = false
  await act('Play: continue paused work', 'press', undefined, false)
  expect(actions.filter((call) => call.name === 'play')).toEqual([])
  approval.given = true
  await act('Play: continue paused work', 'press')
  expect(actions).toContainEqual({ name: 'play', args: null, source: 'agent' })
})

it('continues from the active rate-limit card when an agent presses Play', async () => {
  const limit = {
    provider: 'test',
    model: 'test-model',
    error: 'Rate limited',
    at: 10,
    conversationId: parseConversationId(42),
  }
  const entry = {
    kind: 'pause.limit',
    id: 12,
    conversationId: 1,
    data: limit,
  } as unknown as EntryRecord
  const container = renderSolid(() => (
    <>
      <Limit entry={entry} />
      <Play />
    </>
  ))
  await tick()
  pause()
  server()
    .of(1)!
    .send('doc', { kind: PauseDoc.kind, value: { paused: true, limit, since: limit.at } })
  await tick()
  expect(container.querySelector('[data-pause-limit][data-attention]')).not.toBeNull()
  await expectDistinctAgentNames(agent)
  const play = agent
    .snapshot()
    .find((control) => !control.offPage && control.label === 'Play after rate limit')!
  await act(play.ref, 'press')
  expect(actions).toEqual([{ name: 'play', args: null, source: 'agent' }])
  expect(container.querySelector('[data-pause-limit][data-attention]')).toBeNull()
  expect(container.textContent).toContain('continued after Play')
})

it('names each running task’s conversation as the transcript does: feature tag, else its live title', async () => {
  const branch = parseConversationId(42)
  const plain = parseConversationId(43)
  state().running = [
    { task: 1, conversationId: branch, what: 'bash' },
    { task: 2, conversationId: plain, what: 'model response' },
  ]
  const container = await mountStatus()
  stream().send('conversations', [
    { id: branch, title: 'Branch title' },
    { id: plain, title: 'Plain title' },
  ] as unknown as ConversationSummary[])
  pause()
  await tick()
  await openPause()
  server()
    .of(1)!
    .send('doc', {
      kind: 'ultimate.conversation-overview',
      value: { conversations: { 42: { runState: 'working', feature: 'Solid UI' } } },
    })
  await tick()
  const rows = [...container.querySelectorAll('[data-conversation-ref]')].map(
    (row) => row.textContent,
  )
  expect(rows).toEqual(['Solid UI#42', 'Plain title#43'])
  expect(container.querySelector('[data-feature="Solid UI"]')).not.toBeNull()
})
