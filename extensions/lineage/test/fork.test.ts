import type { EntryRecord } from '@earendil-works/pi-durable'
import { expect, it } from 'vitest'
import { forkStart } from '../fork.web.ts'

const timed = (id: number, conversationId: number, timestamp: number, kind = 'pi.user') =>
  ({
    id,
    conversationId,
    kind,
    model: [{ role: 'user', content: '', timestamp }],
  }) as unknown as EntryRecord

it('dates a fork from its last inherited entry and tells a memory brief from a full copy', () => {
  const copy = [timed(40, 1, 1000), timed(50, 1, 2000), timed(60, 1, 9000), timed(100, 9, 3000)]
  expect(forkStart(copy, 9, 50)).toEqual({ at: 2000, fresh: false, reveal: { entry: 50 } })
  const brief = [timed(50, 1, 2000), timed(100, 9, 3000, 'pi.reset')]
  expect(forkStart(brief, 9, 50)).toMatchObject({ at: 2000, fresh: true })
})

it('dates a fork that has no entries of its own yet', () => {
  expect(forkStart([timed(50, 1, 2000)], 9, 50)).toEqual({
    at: 2000,
    fresh: false,
    reveal: { entry: 50 },
  })
})

it('reveals a fork made at a tool result through the call that made it', () => {
  const call = {
    id: 40,
    conversationId: 1,
    kind: 'pi.assistant',
    model: [
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'ask-1', name: 'message', arguments: {} }],
        timestamp: 1000,
      },
    ],
  } as unknown as EntryRecord
  const result = {
    id: 41,
    conversationId: 1,
    kind: 'pi.tool-result',
    model: [{ role: 'toolResult', toolCallId: 'ask-1', content: [], timestamp: 1500 }],
  } as unknown as EntryRecord
  expect(forkStart([call, result], 9, 41).reveal).toEqual({ entry: 40, call: 'ask-1' })
})
