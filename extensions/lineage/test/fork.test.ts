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
  expect(forkStart(copy, 9, 50)).toEqual({ at: 2000, fresh: false })
  const brief = [timed(50, 1, 2000), timed(100, 9, 3000, 'pi.reset')]
  expect(forkStart(brief, 9, 50)).toEqual({ at: 2000, fresh: true })
  expect(forkStart([timed(50, 1, 2000)], 9, 50)).toBeUndefined()
})
