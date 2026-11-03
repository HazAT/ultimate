import type { EntryRecord } from '@earendil-works/pi-durable'
import { expect, it } from 'vitest'
import { cacheBusts } from '../lib/context-usage.ts'

let id = 0
const answer = (
  input: number,
  cacheRead: number,
  cacheWrite: number,
  timestamp: number,
  model = 'opus',
) =>
  ({
    id: ++id,
    kind: 'pi.assistant',
    model: [
      {
        role: 'assistant',
        provider: 'claude-code',
        model,
        timestamp,
        usage: { input, output: 100, cacheRead, cacheWrite, cacheWrite1h: cacheWrite },
      },
    ],
  }) as unknown as EntryRecord
const marker = (kind: string) => ({ id: ++id, kind }) as unknown as EntryRecord
const minute = 60_000

// The two rebuilds found in stored history: a 9-hour idle expiry, and a changed prefix one minute later.
it('finds cache rebuilds and names why, leaving normal growth and compactions alone', () => {
  const entries = [
    answer(2, 37060, 2220, 0),
    answer(2, 0, 40091, 554 * minute),
    answer(2, 40093, 16858, 555 * minute),
    answer(2, 26625, 33187, 556 * minute),
    marker('pi.system'),
    answer(2, 1000, 59000, 557 * minute),
    answer(2, 60000, 500, 558 * minute, 'sonnet'),
    answer(2, 0, 60500, 559 * minute, 'opus'),
    marker('pi.compaction'),
    answer(2, 0, 12000, 560 * minute),
  ]
  const busts = [...cacheBusts(entries)].map(([at, bust]) => [
    entries.findIndex((entry) => entry.id === at),
    bust.cause,
    bust.written,
  ])
  expect(busts).toEqual([
    [1, 'expired', 40093],
    [3, 'prefix', 33189],
    [5, 'system', 59002],
    [7, 'model', 60502],
  ])
})
