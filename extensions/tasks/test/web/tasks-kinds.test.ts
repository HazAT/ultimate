import { expect, it } from 'vitest'
import type { ConversationId, TaskGraphNode, TaskId } from '@earendil-works/pi-durable'
import { meaning } from '../../kinds.ts'

const task = (kind: string, state: TaskGraphNode['state'], extra: Partial<TaskGraphNode> = {}) =>
  ({
    id: 9 as TaskId,
    kind,
    conversationId: 1 as ConversationId,
    background: true,
    abortRequested: false,
    state,
    conversations: [],
    ...extra,
  }) as TaskGraphNode
const deliver = task('board.delivery', { status: 'running', phase: 'deliver' })
const message = { id: 132, from: 4, to: 21, reply: true, note: false, gist: 'Simplify messaging' }

it('names a delivery by where its message stands: on its way, waiting for the answer, carrying it back', () => {
  expect(meaning(deliver, { message }, 'sent')).toMatchObject({
    group: 'waiting',
    text: 'Delivering to',
    who: 21,
    by: 4,
    detail: 'Simplify messaging',
  })
  expect(meaning(deliver, { message }, 'delivered')).toMatchObject({ text: 'Waiting on', who: 21 })
  // The bounded log dropped it: long placed.
  expect(meaning(deliver, { message }, undefined)).toMatchObject({ text: 'Waiting on' })
  const back = task('board.delivery', { status: 'running', phase: 'reply' })
  expect(meaning(back, { message }, 'answered')).toMatchObject({
    text: 'Delivering the reply to',
    who: 4,
  })
})

it('groups by meaning, whoever owns the task, and keeps an unknown kind under its raw name', () => {
  const at = Date.now()
  expect(
    meaning(
      task('ultimate.automation-scheduler', { status: 'sleeping', phase: 'sleep', until: at }),
      { automation: 'Dream before compaction' },
    ),
  ).toMatchObject({ group: 'scheduled', text: 'Dream before compaction', until: at })
  expect(
    meaning(task('workspaces.lander', { status: 'running', phase: 'land' }), { conversation: 7 }),
  ).toMatchObject({ group: 'landing', who: 7, detail: 'land' })
  expect(
    meaning(
      task(
        'ultimate.subagent-anchor',
        { status: 'running', phase: 'done' },
        {
          conversations: [12 as ConversationId],
        },
      ),
      undefined,
    ),
  ).toMatchObject({ group: 'running', text: 'Subagent' })
  expect(
    meaning(task('conversations.summary', { status: 'running', phase: 'generate' }), {
      conversation: 5,
    }),
  ).toEqual({
    group: 'background',
    text: 'Summarising',
    who: 5,
  })
  // Owning a conversation does not make an unknown kind a subagent.
  const owning = { conversations: [12 as ConversationId] }
  expect(
    meaning(task('my-ext.thing', { status: 'pending', phase: 'go' }, owning), undefined),
  ).toEqual({
    group: 'background',
    text: 'my-ext.thing',
  })
})
