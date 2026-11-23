import { DIMENSIONS } from './dimensions.ts'
import type { Dimension, Filter } from './dimensions.ts'
import { DAY_MS, shiftDays, startOfDay } from './calendar.ts'
import { dateLabel, parseDay } from './format.ts'

export const RANGES = { today: 'today', '7d': '7 days', '30d': '30 days', all: 'all' } as const
export type RangeKind = keyof typeof RANGES | 'custom'
export type Bucket = 'hour' | 'day' | 'week'
export type Filters = Partial<Record<Dimension, string[]>>

export type View = {
  range: RangeKind
  from?: string
  to?: string
  bucket?: Bucket
  by: Dimension
  split?: Dimension
  filters: Filters
  drills?: Drill[]
}
export type Drill = { dimension: Dimension; by: Dimension; split?: Dimension }
export const DEFAULT_VIEW: View = { range: '7d', by: 'tree', filters: {} }

export type Budget = { day?: number; week?: number; month?: number }

const dayCount = (from: number, to: number) => Math.max(1, Math.round((to - from) / DAY_MS))

export type Window = {
  from?: number
  to?: number
  previous?: { from: number; to: number }
  compare?: string
  days: number
}

export function windowOf(view: View, now: number, since: number | null): Window {
  const today = startOfDay(now)
  const back = (days: number, compare: string): Window => {
    const from = shiftDays(today, 1 - days)
    return {
      from,
      previous: { from: shiftDays(from, -days), to: shiftDays(now, -days) },
      compare,
      days,
    }
  }
  switch (view.range) {
    case 'today':
      return back(1, 'vs yesterday by now')
    case '7d':
      return back(7, 'vs the 7 days before')
    case '30d':
      return back(30, 'vs the 30 days before')
    case 'custom': {
      if (!view.from || !view.to) return back(7, 'vs the 7 days before')
      const from = parseDay(view.from < view.to ? view.from : view.to)
      const end = shiftDays(parseDay(view.from < view.to ? view.to : view.from), 1)
      const days = dayCount(from, end)
      const to = end > now ? undefined : end
      return {
        from,
        to,
        previous: { from: shiftDays(from, -days), to: shiftDays(to ?? now, -days) },
        compare: `vs the ${days} day${days === 1 ? '' : 's'} before`,
        days,
      }
    }
    case 'all':
    default:
      return { days: since === null ? 1 : dayCount(startOfDay(since), shiftDays(today, 1)) }
  }
}

export function clip(window: Window, now: number, since: number | null): Window {
  if (window.from === undefined || since === null) return window
  const first = startOfDay(since)
  const to = window.to ?? now
  if (first <= window.from || first >= to) return window
  return { ...window, from: first, days: dayCount(first, shiftDays(startOfDay(to - 1), 1)) }
}

export function rangeLabel(window: Window, now: number, since: number | null) {
  if (window.from === undefined) return since === null ? 'all time' : `since ${dateLabel(since)}`
  const last = window.to === undefined ? now : window.to - 1
  const first = dateLabel(window.from)
  const end = dateLabel(last)
  return first === end ? first : `${first} – ${end}`
}

export function buckets(window: Window): Bucket[] {
  const out: Bucket[] = []
  if (window.days <= 14) out.push('hour')
  out.push('day')
  if (window.days >= 14) out.push('week')
  return out
}

export function bucketOf(view: View, window: Window, allowed: Bucket[]): Bucket {
  if (view.bucket && allowed.includes(view.bucket)) return view.bucket
  if (window.days <= 2 && allowed.includes('hour')) return 'hour'
  return window.days > 120 ? 'week' : 'day'
}

export const filterOf = (window: Pick<Window, 'from' | 'to'>, filters: Filters): Filter => ({
  ...filters,
  ...(window.from === undefined ? {} : { from: window.from }),
  ...(window.to === undefined ? {} : { to: window.to }),
})

export const dimensions = Object.keys(DIMENSIONS) as Dimension[]
export const activeFilters = (filters: Filters) =>
  dimensions.flatMap((dimension) => {
    const values = filters[dimension]
    return values?.length ? [[dimension, values] as const] : []
  })
