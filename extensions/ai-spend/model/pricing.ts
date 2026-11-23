import { CACHE, cacheClass } from './dimensions.ts'
import type { Kind, Row, SpendData } from './types.ts'

export function rate(row: Row, kind: Kind, prices: SpendData['prices']): number {
  if (row.tokens[kind] > 0) return row.cost[kind] / row.tokens[kind]
  const own = prices[`${row.provider}/${row.model}`]?.[kind]
  if (own) return own / 1e6
  if (!row.served) return 0
  const served = Object.entries(prices).find(([key]) => key.endsWith(`/${row.served}`))?.[1][kind]
  return (served ?? 0) / 1e6
}

export function leak(row: Row, prices: SpendData['prices']): number {
  const cls = cacheClass(row)
  const read = rate(row, 'cacheRead', prices)
  if (cls === CACHE.idle || cls === CACHE.other)
    return Math.max(0, row.cost.cacheWrite - row.tokens.cacheWrite * read)
  if (cls === CACHE.miss) return Math.max(0, row.cost.input - row.tokens.input * read)
  return 0
}
