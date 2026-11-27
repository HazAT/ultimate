import { addDays, startOfDay, startOfHour, startOfWeek } from './calendar.ts'
import { OTHER } from './dimensions.ts'
import type { Dimension, Filter } from './dimensions.ts'
import { itemsIn, rangeOf, selected } from './filter.ts'
import { labelOf, namesOf } from './labels.ts'
import type { SpendData } from './types.ts'

const step = {
  hour: (at: number) => at + 3_600_000,
  day: (at: number) => addDays(at, 1),
  week: (at: number) => addDays(at, 7),
}
const floor = { hour: startOfHour, day: startOfDay, week: startOfWeek }

export function series(
  data: SpendData,
  filter: Filter,
  bucket: 'hour' | 'day' | 'week',
  stack: Dimension,
  top = 6,
  now = Date.now(),
) {
  const range = rangeOf(data, filter, now)
  const buckets: number[] = []
  for (
    let at = floor[bucket](range.from);
    at < Math.max(range.to, range.from + 1);
    at = step[bucket](at)
  )
    buckets.push(at)
  const index = new Map(buckets.map((at, i) => [at, i]))
  const names = namesOf(data)
  const sums = new Map<string, { total: number; values: number[] }>()
  for (const item of itemsIn(data, filter)) {
    const at = index.get(floor[bucket](item.row.at))
    if (at === undefined) continue
    for (const part of selected(item, filter, stack)) {
      let sum = sums.get(part.key)
      if (!sum) sums.set(part.key, (sum = { total: 0, values: buckets.map(() => 0) }))
      sum.total += part.usd
      sum.values[at] += part.usd
    }
  }
  const ranked = [...sums].toSorted((a, b) => b[1].total - a[1].total)
  const stacks = ranked
    .slice(0, top)
    .map(([key, sum]) => ({ key, label: labelOf(stack, key, names), values: sum.values }))
  const rest = ranked.slice(top)
  if (rest.length)
    stacks.push({
      key: OTHER,
      label: 'Other',
      values: buckets.map((_, i) => rest.reduce((sum, [, values]) => sum + values.values[i], 0)),
    })
  return { buckets, stacks }
}
