import { expect, it, vi } from 'vitest'
import { inboxItems, keyOf, selection } from '../../items.tsx'
import type { InboxItem } from '../../ui.tsx'
import type { Message } from '../../../messages/refs.ts'

// questions' ui.tsx also exports its answer card, whose imports need the running app.
vi.mock('../../../questions/card.tsx', () => ({ MessageQuestions: () => null }))

const ask = (id: number, at: number, fields: Partial<Message> = {}): Message => ({
  id,
  from: 40 + id,
  to: 'user',
  text: `Question ${id}`,
  at,
  reply: true,
  state: 'delivered',
  ...fields,
})

const log = [
  ask(1, 100),
  ask(2, 200, { state: 'answered' }),
  ask(3, 300),
  ask(4, 400, { reply: false }),
  ask(5, 500, { to: 7 }),
  ask(6, 600, { state: 'dismissed' }),
  ask(7, 700),
]

const item = (key: string, at: number): InboxItem => ({
  key,
  at,
  tag: 'shell',
  title: key,
  pane: null,
})

it('lists the open questions to the user and the provided items, oldest first', () => {
  expect(inboxItems(log).map((entry) => entry.key)).toEqual(['message:1', 'message:3', 'message:7'])
  const merged = inboxItems(log, [[item('shell:a', 350)], undefined, [item('mail:b', 50)]])
  expect(merged.map((entry) => entry.key)).toEqual([
    'mail:b',
    'message:1',
    'message:3',
    'shell:a',
    'message:7',
  ])
})

it('moves on to the next oldest when the shown item is answered', () => {
  const before = inboxItems(log)
  expect(selection(before, 'message:3', 1)).toBe('message:3')
  const after = inboxItems(log.map((m) => (m.id === 3 ? { ...m, state: 'answered' as const } : m)))
  // Item 3 stood at index 1; item 7 now stands there.
  expect(selection(after, 'message:3', 1)).toBe('message:7')
  // The newest answered: the one before it shows; the last answered: nothing.
  expect(selection(after, 'message:7', 1)).toBe('message:7')
  expect(selection([after[0]], 'message:7', 1)).toBe('message:1')
  expect(selection([], 'message:1', 0)).toBeUndefined()
})

it('reads a link as a key, a plain number as a message id', () => {
  expect(keyOf('12')).toBe('message:12')
  expect(keyOf(12)).toBe('message:12')
  expect(keyOf('shell:3')).toBe('shell:3')
  expect(keyOf('')).toBeUndefined()
})
