import { addDays, startOfDay } from './calendar.ts'
import { itemsOf } from './data.ts'
import type { Item } from './data.ts'
import { DIMENSIONS, SPLIT, keyOf, parts } from './dimensions.ts'
import type { Dimension, Filter, Part } from './dimensions.ts'
import type { Row, SpendData } from './types.ts'

function shareOf(item: Item, dimension: Dimension, values: readonly string[]) {
  const all = parts(item.row, item.conversation, dimension)
  const totalUsd = all.reduce((sum, part) => sum + part.usd, 0)
  const picked = all.filter((part) => values.includes(part.key))
  if (totalUsd > 0) return picked.reduce((sum, part) => sum + part.usd, 0) / totalUsd
  const totalTokens = all.reduce((sum, part) => sum + part.tokens, 0)
  return totalTokens > 0
    ? picked.reduce((sum, part) => sum + part.tokens, 0) / totalTokens
    : picked.length
      ? 1
      : 0
}

const matches = (item: Item, filter: Filter) => {
  if (filter.from !== undefined && item.row.at < filter.from) return false
  if (filter.to !== undefined && item.row.at >= filter.to) return false
  for (const dimension of Object.keys(DIMENSIONS) as Dimension[]) {
    const values = filter[dimension]
    if (!values) continue
    if (SPLIT.has(dimension)) {
      if (!parts(item.row, item.conversation, dimension).some((part) => values.includes(part.key)))
        return false
    } else if (!values.includes(keyOf(item.row, item.conversation, dimension))) return false
  }
  return true
}

export const itemsIn = (data: SpendData, filter: Filter): Item[] =>
  itemsOf(data).filter((item) => matches(item, filter))

export const filterRows = (data: SpendData, filter: Filter): Row[] =>
  itemsIn(data, filter).map((item) => item.row)

export function scaleOf(item: Item, filter: Filter, dimension: Dimension) {
  let weight = 1
  for (const other of SPLIT) {
    const values = filter[other]
    if (other !== dimension && values) weight *= shareOf(item, other, values)
  }
  return weight
}

export function selected(item: Item, filter: Filter, dimension: Dimension): Part[] {
  let out = parts(item.row, item.conversation, dimension)
  const own = filter[dimension]
  if (own && SPLIT.has(dimension)) out = out.filter((part) => own.includes(part.key))
  const weight = scaleOf(item, filter, dimension)
  return weight === 1
    ? out
    : out.map((part) => ({ ...part, usd: part.usd * weight, tokens: part.tokens * weight }))
}

export const amount = (item: Item, filter: Filter) =>
  selected(item, filter, 'conversation').reduce((sum, part) => sum + part.usd, 0)

export const rangeOf = (data: SpendData, filter: Filter, now = Date.now()) => ({
  from: filter.from ?? data.since ?? now,
  to: filter.to ?? now,
})

export const days = (from: number, to: number) => {
  const out: number[] = []
  for (let at = startOfDay(from); at < Math.max(to, from + 1); at = addDays(at, 1)) out.push(at)
  return out
}
