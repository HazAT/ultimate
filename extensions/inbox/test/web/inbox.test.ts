import type { ConversationId } from '@earendil-works/pi-durable'
import { expect, it } from 'vitest'
import {
  answeredToday,
  inboxItems,
  keyOf,
  lead,
  selectionAfterChange,
  shown,
  toRow,
  UNLOADED,
} from '../../items.ts'
import type { Anchor, Selection } from '../../items.ts'
import type { InboxItem } from '../../points.ts'
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

const step = (entries: Anchor[], selected: Selection) =>
  selectionAfterChange(entries, selected) ?? selected
const at = (key: string, time: number): Anchor => ({ key, at: time })

it('keeps the item that took the shown one’s place when a newer one arrives, mounted or not', () => {
  const [a, b, d] = [at('a', 10), at('b', 20), at('d', 40)]
  let selected = step([a, b], { key: 'c', at: 30, open: true })
  expect(selected).toEqual({ key: 'b', at: 20, open: true })
  selected = step([a, b, d], selected)
  expect(shown([a, b, d], selected)?.key).toBe('b')
})

it('waits for a linked key, then moves on from it by its real age', () => {
  const [a, b, c] = [at('a', 10), at('b', 20), at('c', 30)]
  let selected = step([a, c], { key: 'b', at: UNLOADED, open: true })
  expect(selected).toEqual({ key: 'b', at: UNLOADED, open: true })
  selected = step([a, b, c], selected)
  expect(selected).toEqual({ key: 'b', at: 20, open: true })
  selected = step([a, c], selected)
  expect(selected).toEqual({ key: 'c', at: 30, open: true })
})

it('moves forward past items of the same age', () => {
  const entries = inboxItems([], [[item('x:b', 10), item('x:a', 10), item('x:c', 20)]])
  expect(entries.map((entry) => entry.key)).toEqual(['x:a', 'x:b', 'x:c'])
  const left = entries.filter((entry) => entry.key !== 'x:b')
  expect(shown(left, { key: 'x:b', at: 10, open: false })?.key).toBe('x:c')
})

it('reads a link as a key, a plain number as a message id', () => {
  expect(keyOf('12')).toBe('message:12')
  expect(keyOf(12)).toBe('message:12')
  expect(keyOf('shell:3')).toBe('shell:3')
  expect(keyOf('')).toBeUndefined()
})

it('uses inline Markdown text for rows and answered labels, without link URLs or images', () => {
  const pr = '[PR 1784](https://example.com/pr/1784)'
  const text = `**Remove the throttle: ${pr}**\n\nBody`
  const message = ask(1, 1, { text })
  expect(lead(text)).toEqual({ title: `Remove the throttle: ${pr}`, body: 'Body' })
  expect(toRow({ key: 'message:1', at: 1, message }).title).toBe('Remove the throttle: PR 1784')
  expect(
    toRow({
      key: 'shell:a',
      at: 1,
      item: { ...item('shell:a', 1), title: `${pr} ![image](https://example.com/image.png)` },
    }).title,
  ).toBe('PR 1784')
  const now = Date.now()
  expect(
    answeredToday([{ ...message, state: 'answered' }, ask(2, now, { from: 'user', re: 1 })], now)[0]
      .title,
  ).toBe('Remove the throttle: PR 1784')
  expect(
    toRow({
      key: 'message:2',
      at: 1,
      message: ask(2, 1, { text: `## Remove the \`throttle\` _now_: ${pr}\nBody` }),
    }).title,
  ).toBe('Remove the throttle now: PR 1784')
})
