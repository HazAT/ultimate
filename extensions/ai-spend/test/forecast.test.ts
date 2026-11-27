import { expect, it } from 'vitest'
import { forecast } from '../model/forecast.ts'

// Thursday 19 Nov 2026, noon local: the week runs Mon 16 – Sun 22, today has half of itself left.
const NOW = new Date(2026, 10, 19, 12).getTime()
const pad = (n: number) => String(n).padStart(2, '0')
/** `n` complete days ending yesterday, then today, each `usd(i)` (i = 0 is the oldest). */
const days = (n: number, usd: (i: number) => number, today = 0) => {
  const out = []
  for (let i = 0; i < n; i++) {
    const date = new Date(2026, 10, 19 - n + i)
    out.push({
      day: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
      usd: usd(i),
    })
  }
  out.push({ day: '2026-11-19', usd: today })
  return out
}
const close = (actual: number, expected: number) =>
  expect(Math.abs(actual - expected)).toBeLessThan(1e-9)

it('forecast: fewer than 7 complete days is not ready and says how many more are needed', () => {
  const result = forecast(
    days(4, () => 10),
    NOW,
  )
  expect(result.ready).toBe(false)
  expect(result.daysNeeded).toBe(3)
  expect(result.days).toBe(4)
  expect(forecast([], NOW).daysNeeded).toBe(7)
})

it('forecast: 7 to 13 days is ready, at the mean of the last 7 complete days, with no band', () => {
  // Older days at $100 do not count; the last 7 are $10, today $4 so far.
  const result = forecast(
    days(10, (i) => (i < 3 ? 100 : 10), 4),
    NOW,
  )
  expect(result.ready).toBe(true)
  expect(result.daysNeeded).toBe(0)
  close(result.rate, 10)
  // Week: Mon–Wed $30 + today $4, then 3.5 days left (half of today, Fri–Sun).
  close(result.week.spent, 34)
  close(result.week.projected, 34 + 10 * 3.5)
  expect(result.week.from).toBe('2026-11-16')
  expect(result.week.to).toBe('2026-11-22')
  expect(result.week.low).toBe(undefined)
  // Month: 9 Nov – today; 11.5 days left of November.
  close(result.month.spent, 3 * 100 + 7 * 10 + 4)
  close(result.month.projected, 374 + 10 * 11.5)
  expect(result.month.to).toBe('2026-11-30')
})

it('forecast: 14 days or more carries an ~80% band; budgets say whether it goes over', () => {
  const result = forecast(
    days(14, (i) => (i % 2 ? 12 : 8)),
    NOW,
    { week: 50, month: 1000 },
  )
  expect(result.ready).toBe(true)
  const sigma = Math.sqrt((14 * 4) / 13)
  close(result.week.high! - result.week.projected, 1.28 * sigma * Math.sqrt(3.5))
  expect(result.week.low! < result.week.projected).toBe(true)
  expect(result.week.budget).toBe(50)
  expect(result.week.over).toBe(true)
  expect(result.month.over).toBe(false)
  expect(
    forecast(
      days(14, () => 10),
      NOW,
    ).week.over,
  ).toBe(undefined)
})

it('forecast: today runs to midnight at the daily rate, against the daily budget', () => {
  // The last 7 days at $10, $4 so far today, half of it left: on pace for $9.
  const result = forecast(
    days(7, () => 10, 4),
    NOW,
    { day: 8 },
  )
  expect(result.today.from).toBe('2026-11-19')
  expect(result.today.to).toBe('2026-11-19')
  close(result.today.spent, 4)
  close(result.today.projected, 9)
  expect(result.today.budget).toBe(8)
  expect(result.today.over).toBe(true)
  expect(
    forecast(
      days(7, () => 10, 4),
      NOW,
      { day: 10 },
    ).today.over,
  ).toBe(false)
})
