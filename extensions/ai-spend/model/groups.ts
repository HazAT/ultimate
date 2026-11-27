import { dayKey } from './calendar.ts'
import { bandOrder } from './dimensions.ts'
import type { Dimension, Filter } from './dimensions.ts'
import type { Item } from './data.ts'
import { days, itemsIn, rangeOf, selected } from './filter.ts'
import { labelOf, namesOf } from './labels.ts'
import type { Names } from './labels.ts'
import type { SpendData } from './types.ts'

export type Group = {
  key: string
  label: string
  usd: number
  tokens: number
  responses: number
  children?: Group[]
  daily: number[]
}

function groupItems(
  items: Item[],
  filter: Filter,
  by: Dimension,
  then: Dimension | undefined,
  dayStarts: number[],
  names: Names,
): Group[] {
  const index = new Map(dayStarts.map((at, i) => [dayKey(at), i]))
  const groups = new Map<string, Group & { items: Item[] }>()
  for (const item of items)
    for (const part of selected(item, filter, by)) {
      let entry = groups.get(part.key)
      if (!entry) {
        entry = {
          key: part.key,
          label: labelOf(by, part.key, names),
          usd: 0,
          tokens: 0,
          responses: 0,
          daily: dayStarts.map(() => 0),
          items: [],
        }
        groups.set(part.key, entry)
      }
      entry.usd += part.usd
      entry.tokens += part.tokens
      if (!item.row.overhead) entry.responses += 1
      const day = index.get(dayKey(item.row.at))
      if (day !== undefined) entry.daily[day] += part.usd
      entry.items.push(item)
    }
  return [...groups.values()]
    .map(({ items: inGroup, ...rest }) =>
      then
        ? {
            ...rest,
            children: groupItems(
              inGroup,
              { ...filter, [by]: [rest.key] },
              then,
              undefined,
              dayStarts,
              names,
            ),
          }
        : rest,
    )
    .toSorted((a, b) => (by === 'prompt' ? bandOrder(a.key) - bandOrder(b.key) : b.usd - a.usd))
}

export function group(
  data: SpendData,
  filter: Filter,
  by: Dimension,
  then?: Dimension,
  now = Date.now(),
): Group[] {
  const range = rangeOf(data, filter, now)
  const items = itemsIn(data, filter)
  return groupItems(items, filter, by, then, days(range.from, range.to), namesOf(data))
}
