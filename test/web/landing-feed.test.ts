import { expect, it } from 'vitest'
import { landingFeed } from '../../extensions/lineage/landings.ts'
import type { RootEvent } from '../../extensions/lineage/types.ts'

// Dates are built on the local calendar, so every timezone groups and labels the same.
const ms = (month: number, day: number, hour = 12, year = 2026) =>
  new Date(year, month, day, hour).getTime()

const landed = (overrides: Partial<Extract<RootEvent, { type: 'landed' }>> = {}) =>
  ({
    type: 'landed',
    entry: 9,
    at: ms(10, 5),
    sha: 'abc1234def5678',
    base: '0000000',
    commits: 2,
    ...overrides,
  }) as Extract<RootEvent, { type: 'landed' }>

it('answers nothing without landings', () => {
  expect(landingFeed([], ms(10, 5, 9))).toEqual([])
})

it('groups same-day landings newest first', () => {
  const days = landingFeed(
    [
      landed({ entry: 3, at: ms(10, 5, 9), sha: 'ccccccc', title: 'First' }),
      landed({ entry: 7, at: ms(10, 5, 15), sha: 'bbbbbbb', title: 'Second' }),
      landed({ entry: 5, at: ms(10, 5, 12), sha: 'aaaaaaa', title: 'Third' }),
    ],
    ms(10, 5, 18),
  )
  expect(days).toHaveLength(1)
  expect(days[0].label).toBe('Today')
  expect(days[0].items.map((item) => item.title)).toEqual(['Second', 'Third', 'First'])
})

it('orders days newest first, labelling them Today, Yesterday and a date', () => {
  const days = landingFeed(
    [
      landed({ entry: 9, at: ms(10, 5, 8) }),
      landed({ entry: 6, at: ms(10, 4, 20) }),
      landed({ entry: 4, at: ms(9, 28, 10) }),
      landed({ entry: 2, at: ms(11, 15, 10, 2025) }),
    ],
    ms(10, 5, 12),
  )
  expect(days.map((day) => day.label)).toEqual([
    'Today',
    'Yesterday',
    expect.stringMatching(/28/),
    expect.stringMatching(/, 2025$/),
  ])
  expect(days[2].items.map((item) => item.entry)).toEqual([4])
})

it('tolerates missing fields and keeps only dated landings', () => {
  const days = landingFeed(
    [
      landed({
        sha: undefined,
        base: undefined,
        commits: undefined,
        title: undefined,
        from: 4,
        at: ms(10, 5, 10),
      }),
      landed({ at: undefined, entry: 11 }),
      { type: 'note', entry: 12, at: ms(10, 5, 11), text: 'not a landing' },
      { type: 'branched', entry: 13, branch: 4, intent: 'work', at: ms(10, 5, 11) },
    ],
    ms(10, 5, 12),
  )
  expect(days).toHaveLength(1)
  expect(days[0].items).toEqual([{ at: ms(10, 5, 10), entry: 9, conversation: 4 }])
})
