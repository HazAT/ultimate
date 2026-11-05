import type { EntryRecord } from '@earendil-works/pi-durable'
import { expect, it } from 'vitest'
import { reachedFork } from '../../web/src/app/fork.ts'

const row = (id: number, conversationId: number, kind = 'pi.user') =>
  ({ id, conversationId, kind, createdAt: 0 }) as unknown as EntryRecord

it('keeps paging a long fork until its oldest own entry and the inherited one before it are loaded', () => {
  // Fork #9 of #1 at entry 50; it has 300 own entries from 100, and the window holds its newest 150.
  const own = Array.from({ length: 300 }, (_, index) => row(100 + index, 9))
  const marker = row(40, 1, 'pi.compaction')
  expect(reachedFork(own.slice(150), 9)).toBe(false)
  expect(reachedFork(own, 9)).toBe(false)
  expect(reachedFork([marker, row(50, 1), ...own], 9)).toBe(true)
})

it('keeps paging a fork until the context it carries in is loaded', () => {
  // Fork #9 of #1, no reset of its own: its first context is #1's from its last reset (10) on.
  const reset = row(10, 1, 'pi.reset')
  const inherited = Array.from({ length: 140 }, (_, index) => row(11 + index, 1))
  const own = Array.from({ length: 10 }, (_, index) => row(200 + index, 9))
  expect(reachedFork([...inherited, ...own], 9)).toBe(false)
  expect(reachedFork([reset, ...inherited, ...own], 9)).toBe(true)
})

it('keeps paging back to the entries a compaction kept before its marker', () => {
  const compaction = { ...row(40, 1, 'pi.compaction'), head: 20 } as EntryRecord
  const own = row(100, 9)
  expect(reachedFork([row(30, 1), compaction, row(50, 1), own], 9)).toBe(false)
  expect(reachedFork([row(20, 1), row(30, 1), compaction, row(50, 1), own], 9)).toBe(true)
})

it('stops at the fork point when the fork starts its own context', () => {
  expect(reachedFork([row(50, 1), row(100, 9, 'pi.reset'), row(101, 9)], 9)).toBe(true)
})

it('never stops a conversation that is not a fork', () => {
  expect(reachedFork([row(1, 9), row(2, 9)], 9)).toBe(false)
  expect(reachedFork([], 9)).toBe(false)
})
