import type { ConversationId } from '@earendil-works/pi-durable'
import { expect, it } from 'vitest'
import { inboxItems, keyOf, shown } from '../../items.ts'
import type { InboxItem } from '../../ui.tsx'
import type { Message } from '../../../messages/refs.ts'

const ask = (id: number, at: number, fields: Partial<Message> = {}): Message => ({
  id,
  from: (40 + id) as ConversationId,
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
  ask(5, 500, { to: 7 as ConversationId }),
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
  const merged = inboxItems(log, [[item('shell:a', 350)], [item('mail:b', 50)]])
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
  const selected = { key: 'message:3', at: 300, open: true }
  expect(shown(before, null)?.key).toBe('message:1')
  expect(shown(before, selected)?.key).toBe('message:3')
  const after = inboxItems(
    log.map((m) => (m.id === 3 ? { ...m, state: 'answered' as const } : m)),
    [[item('shell:old', 200)]],
  )
  expect(shown(after, selected)?.key).toBe('message:7')
  expect(shown(after.slice(0, -1), { key: 'message:7', at: 700, open: false })?.key).toBe(
    'shell:old',
  )
  expect(shown([], selected)).toBeUndefined()
})

it('shows the linked key when it loads, even without its timestamp', () => {
  const linked = { key: 'message:7', at: 0, open: true }
  const entries = inboxItems(log)
  expect(shown(entries.slice(0, -1), linked)?.key).toBe('message:1')
  expect(shown(entries, linked)?.key).toBe('message:7')
})

it('reads a link as a key, a plain number as a message id', () => {
  expect(keyOf('12')).toBe('message:12')
  expect(keyOf(12)).toBe('message:12')
  expect(keyOf('shell:3')).toBe('shell:3')
  expect(keyOf('')).toBeUndefined()
})
