import { cacheClass, prompt } from './dimensions.ts'
import type { Filter } from './dimensions.ts'
import { amount, itemsIn } from './filter.ts'
import { leak } from './pricing.ts'
import type { Conversation, Row, SpendData } from './types.ts'

export type Turn = {
  row: Row
  conversation: Conversation
  usd: number
  prompt: number
  cache: string
  leakUsd: number
}

export function turns(data: SpendData, filter: Filter, limit = 10): Turn[] {
  const out: Turn[] = []
  for (const item of itemsIn(data, filter)) {
    if (item.row.overhead) continue
    const usd = amount(item, filter)
    const weight = item.row.cost.total > 0 ? usd / item.row.cost.total : 1
    out.push({
      ...item,
      usd,
      prompt: prompt(item.row),
      cache: cacheClass(item.row),
      leakUsd: leak(item.row, data.prices) * weight,
    })
  }
  return out.toSorted((a, b) => b.usd - a.usd).slice(0, limit)
}
