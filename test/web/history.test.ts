import type { EntryRecord } from '@earendil-works/pi-durable'
import { expect, it, vi } from 'vitest'
import { gapAfter, mergeRows } from '../../web/src/app/history.ts'

// The client reads the page's location on import; these rules never call it.
vi.mock('../../web/src/sdk/client.ts', () => ({ api: {} }))

const row = (id: number, text = '') =>
  ({ id, conversationId: 1, kind: 'pi.user', text }) as unknown as EntryRecord

it('fills what a fresh window leaves between it and the rows kept below it', () => {
  // A reconnect brought a window starting at 500; the reader had rows up to 120 loaded.
  expect(gapAfter([row(100), row(120), row(600)], 500)).toBe(121)
  // The window starts right after the kept rows, or nothing is kept below it: nothing to fill.
  expect(gapAfter([row(100), row(120)], 121)).toBeUndefined()
  expect(gapAfter([row(600)], 500)).toBeUndefined()
})

it('merges rows by entry id, the copy read last winning', () => {
  const merged = mergeRows([row(1, 'old'), row(2)], [row(1, 'new'), row(3)])
  expect(merged.map((entry) => entry.id)).toEqual([1, 2, 3])
  expect((merged[0] as unknown as { text: string }).text).toBe('new')
})
