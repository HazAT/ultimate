import { expect, it } from 'vitest'
import { formatAgo, formatDuration } from '../lib/format.shared.ts'

const minute = 60_000
const day = 24 * 60 * minute
const now = new Date(2026, 9, 24, 12).getTime()

it('counts minutes, hours and days, rounding down, and treats future times as now', () => {
  const at = (ms: number) => formatAgo(now - ms, now)
  expect([at(-5 * minute), at(0), at(59_999), at(minute)]).toEqual(['now', 'now', 'now', '1m'])
  expect([at(60 * minute - 1), at(60 * minute)]).toEqual(['59m', '1h'])
  expect([at(day - 1), at(day)]).toEqual(['23h', '1d'])
  expect(at(7 * day - 1)).toBe('6d')
})

it('falls back to a short date from 7 days on, with the year only when it differs', () => {
  const short = { month: 'short', day: 'numeric' } as const
  expect(formatAgo(now - 7 * day, now)).toBe(
    new Date(now - 7 * day).toLocaleDateString(undefined, short),
  )
  const lastYear = new Date(2025, 9, 12).getTime()
  expect(formatAgo(lastYear, now)).toBe(
    new Date(lastYear).toLocaleDateString(undefined, { month: 'short', year: '2-digit' }),
  )
})

it('reads in a sentence with ago, the date fallback unchanged', () => {
  const ago = (ms: number) => formatAgo(now - ms, now, { ago: true })
  expect([ago(0), ago(5 * minute), ago(3 * 60 * minute), ago(2 * day)]).toEqual([
    'just now',
    '5m ago',
    '3h ago',
    '2d ago',
  ])
  expect(ago(8 * day)).toBe(formatAgo(now - 8 * day, now))
})

it('says durations in their two largest units, dropping a zero second unit', () => {
  const second = 1000
  expect(
    [420, 3_250, 45 * second, 64 * second, 2 * 60 * minute, 90 * minute, day + 4 * 60 * minute].map(
      formatDuration,
    ),
  ).toEqual(['420ms', '3.2s', '45s', '1m 4s', '2h', '1h 30m', '1d 4h'])
})
