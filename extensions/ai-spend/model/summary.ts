import { prompt } from './dimensions.ts'
import type { Filter } from './dimensions.ts'
import { amount, itemsIn } from './filter.ts'
import { rate } from './pricing.ts'
import type { SpendData } from './types.ts'

export type Summary = {
  usd: number
  responses: number
  cacheHitRate: number
  cacheSavingsUsd: number
  estimatedShare: number
  overheadUsd: number
}

export function summary(data: SpendData, filter: Filter): Summary {
  let usd = 0
  let responses = 0
  let read = 0
  let prompts = 0
  let savings = 0
  let estimated = 0
  let overhead = 0
  for (const item of itemsIn(data, filter)) {
    const { row } = item
    const spent = amount(item, filter)
    const weight = row.cost.total > 0 ? spent / row.cost.total : 1
    usd += spent
    if (!row.overhead) responses += 1
    else overhead += spent
    if (!row.fromProvider) estimated += spent
    read += row.tokens.cacheRead * weight
    prompts += prompt(row) * weight
    if (row.tokens.cacheRead > 0)
      savings +=
        row.tokens.cacheRead *
        weight *
        Math.max(0, rate(row, 'input', data.prices) - rate(row, 'cacheRead', data.prices))
  }
  return {
    usd,
    responses,
    cacheHitRate: prompts > 0 ? read / prompts : 0,
    cacheSavingsUsd: savings,
    estimatedShare: usd > 0 ? estimated / usd : 0,
    overheadUsd: overhead,
  }
}
