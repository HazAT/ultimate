import type { InboxItem, ConversationId } from '@earendil-works/pi-durable'
import { describe, expect, it, vi } from 'vitest'
import { HttpError } from '../../web/src/sdk/api.ts'
import {
  atFirstLine,
  mergedSteer,
  previewParts,
  queuedInput,
  recallQueued,
  recalledText,
  withdrawQueuedSteer,
} from '../../web/src/app/queued.ts'

type Content = Extract<InboxItem, { content: unknown }>['content']
type Cancel = (submissionId: number, id?: number) => Promise<unknown>
const cancelling = (implementation: Cancel) => ({ cancelSubmission: vi.fn<Cancel>(implementation) })
const accepting = () => cancelling(() => Promise.resolve({}))
const taken = (ids: number[] = []) =>
  cancelling((id) =>
    ids.includes(id) ? Promise.reject(new HttpError(409, 'taken')) : Promise.resolve({}),
  )

const steer = (id: number, content: Content = `steer ${id}`): InboxItem => ({
  id: id as InboxItem['id'],
  mode: 'steer',
  content,
})
const followUp = (id: number): InboxItem => ({
  id: id as InboxItem['id'],
  mode: 'followUp',
  content: `follow-up ${id}`,
})
const image = { data: 'QUJD', mimeType: 'image/png' }

describe('previewParts', () => {
  it('keeps a short text whole and splits a long one into a truncating head and a fixed tail', () => {
    expect(previewParts('short')).toEqual({ head: 'short' })
    const long = `${'a'.repeat(60)}MIDDLE${'z'.repeat(60)}`
    const parts = previewParts(long)
    expect(parts.head + parts.tail).toBe(long)
    expect(parts.tail).toBe('z'.repeat(40))
  })
  it('marks line breaks with ↵ so a merged steer shows its seams', () => {
    expect(previewParts('first\nsecond \n third')).toEqual({ head: 'first ↵ second ↵ third' })
  })
  it('keeps a short merged line whole in the tail, seam included', () => {
    const merged = `${'first steer '.repeat(10)}\nsecond: END`
    expect(previewParts(merged)).toEqual({
      head: 'first steer '.repeat(10).trimEnd(),
      tail: ' ↵ second: END',
    })
    const longLast = `${'a'.repeat(30)}\n${'b'.repeat(100)}`
    expect(previewParts(longLast).tail).toBe('b'.repeat(40))
  })
})

describe('atFirstLine', () => {
  it('is true on the first line, empty input included, and false below it', () => {
    expect(atFirstLine('', 0)).toBe(true)
    expect(atFirstLine('one line', 4)).toBe(true)
    expect(atFirstLine('one\ntwo', 3)).toBe(true)
    expect(atFirstLine('one\ntwo', 4)).toBe(false)
    expect(atFirstLine('one\ntwo', 7)).toBe(false)
  })
})

describe('queuedInput', () => {
  it('reads text and images from string and block content, and nothing from a write', () => {
    expect(queuedInput(steer(1))).toEqual({ text: 'steer 1', images: [] })
    expect(
      queuedInput(
        steer(2, [
          { type: 'text' as const, text: 'look' },
          { type: 'image' as const, ...image },
        ]),
      ),
    ).toEqual({ text: 'look', images: [image] })
    expect(queuedInput({ id: 3 as InboxItem['id'], mode: 'write', entry: {} })).toBeUndefined()
  })
})

describe('withdrawQueuedSteer', () => {
  it('cancels the last queued steer and returns its content for the merge', async () => {
    const api = accepting()
    const items = [followUp(1), steer(2), steer(3, [{ type: 'image' as const, ...image }])]
    await expect(withdrawQueuedSteer(api, 7 as ConversationId, items)).resolves.toEqual({
      text: '',
      images: [image],
    })
    expect(api.cancelSubmission).toHaveBeenCalledWith(3, 7)
    expect(api.cancelSubmission).toHaveBeenCalledTimes(1)
  })
  it('merges nothing without a queued steer', async () => {
    const api = accepting()
    await expect(
      withdrawQueuedSteer(api, 7 as ConversationId, [followUp(1)]),
    ).resolves.toBeUndefined()
    expect(api.cancelSubmission).not.toHaveBeenCalled()
  })
  it('sends the new steer alone when the run took the queued one meanwhile', async () => {
    await expect(
      withdrawQueuedSteer(taken([2]), 7 as ConversationId, [steer(2)]),
    ).resolves.toBeUndefined()
  })
  it('surfaces any other cancellation failure', async () => {
    const api = cancelling(() => Promise.reject(new HttpError(500, 'down')))
    await expect(withdrawQueuedSteer(api, 7 as ConversationId, [steer(2)])).rejects.toThrow('down')
  })
})

it('mergedSteer joins the texts on a new line and keeps both inputs’ images in order', () => {
  expect(mergedSteer({ text: 'first', images: [image] }, { text: 'second', images: [] })).toEqual({
    text: 'first\nsecond',
    images: [image],
  })
})

describe('recallQueued', () => {
  it('cancels every queued input and returns steers before follow-ups', async () => {
    const api = accepting()
    const recalled = await recallQueued(api, 7 as ConversationId, [
      followUp(1),
      steer(2),
      followUp(3),
    ])
    expect(recalled.map((input) => input.text)).toEqual(['steer 2', 'follow-up 1', 'follow-up 3'])
    expect(api.cancelSubmission.mock.calls.map(([id]) => id)).toEqual([2, 1, 3])
  })
  it('leaves out an input the run took meanwhile', async () => {
    const recalled = await recallQueued(taken([2]), 7 as ConversationId, [steer(2), followUp(3)])
    expect(recalled.map((input) => input.text)).toEqual(['follow-up 3'])
  })
})

it('recalledText appends the recalled inputs after the current text with blank lines between', () => {
  const recalled = [
    { text: 'a', images: [] },
    { text: 'b', images: [] },
  ]
  expect(recalledText('typed', recalled)).toBe('typed\n\na\n\nb')
  expect(recalledText('  ', recalled)).toBe('a\n\nb')
})
