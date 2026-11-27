import { DAY_MS, dayKey } from './calendar.ts'

export const READY_DAYS = 7
export const BAND_DAYS = 14
const RATE_DAYS = 7
const SPREAD_DAYS = 28
const Z80 = 1.28

export type Projection = {
  from: string
  to: string
  spent: number
  projected: number
  low?: number
  high?: number
  budget?: number
  over?: boolean
}
export type Forecast = {
  ready: boolean
  daysNeeded: number
  days: number
  rate: number
  today: Projection
  week: Projection
  month: Projection
}

export function forecast(
  daily: readonly { day: string; usd: number }[],
  now: number,
  budget: { day?: number; week?: number; month?: number } = {},
): Forecast {
  const today = new Date(now)
  const todayKey = dayKey(now)
  const complete = daily.filter((entry) => entry.day < todayKey).map((entry) => entry.usd)
  const recent = complete.slice(-RATE_DAYS)
  const rate = recent.length ? recent.reduce((sum, usd) => sum + usd, 0) / recent.length : 0
  let sigma: number | undefined
  if (complete.length >= BAND_DAYS) {
    const spread = complete.slice(-SPREAD_DAYS)
    const mean = spread.reduce((sum, usd) => sum + usd, 0) / spread.length
    sigma = Math.sqrt(spread.reduce((sum, usd) => sum + (usd - mean) ** 2, 0) / (spread.length - 1))
  }
  const project = (start: Date, end: Date, limit: number | undefined): Projection => {
    const from = dayKey(start.getTime())
    const to = dayKey(end.getTime() - 1)
    const spent = daily
      .filter((entry) => entry.day >= from && entry.day <= todayKey)
      .reduce((sum, entry) => sum + entry.usd, 0)
    const left = Math.max(0, (end.getTime() - now) / DAY_MS)
    const projected = spent + rate * left
    const band = sigma === undefined ? undefined : Z80 * sigma * Math.sqrt(left)
    return {
      from,
      to,
      spent,
      projected,
      ...(band === undefined
        ? {}
        : { low: Math.max(spent, projected - band), high: projected + band }),
      ...(limit === undefined ? {} : { budget: limit, over: projected > limit }),
    }
  }
  const y = today.getFullYear()
  const m = today.getMonth()
  const d = today.getDate()
  const monday = d - ((today.getDay() + 6) % 7)
  return {
    ready: complete.length >= READY_DAYS,
    daysNeeded: Math.max(0, READY_DAYS - complete.length),
    days: complete.length,
    rate,
    today: project(new Date(y, m, d), new Date(y, m, d + 1), budget.day),
    week: project(new Date(y, m, monday), new Date(y, m, monday + 7), budget.week),
    month: project(new Date(y, m, 1), new Date(y, m + 1, 1), budget.month),
  }
}
