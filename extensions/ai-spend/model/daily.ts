import { dayKey } from './calendar.ts'
import type { Filter } from './dimensions.ts'
import { amount, days, itemsIn, rangeOf } from './filter.ts'
import type { SpendData } from './types.ts'

export function daily(
  data: SpendData,
  filter: Filter,
  now = Date.now(),
): { day: string; usd: number }[] {
  if (filter.from === undefined && data.since === null) return []
  const range = rangeOf(data, filter, now)
  const out = days(range.from, range.to).map((at) => ({ day: dayKey(at), usd: 0 }))
  const index = new Map(out.map((entry, i) => [entry.day, i]))
  for (const item of itemsIn(data, filter)) {
    const at = index.get(dayKey(item.row.at))
    if (at !== undefined) out[at].usd += amount(item, filter)
  }
  return out
}
