import { HOUR_MS } from './calendar.ts'
import { CACHE, cacheClass, keyOf, prompt } from './dimensions.ts'
import type { Dimension, Filter } from './dimensions.ts'
import { amount, itemsIn } from './filter.ts'
import { leak, rate } from './pricing.ts'
import type { SpendData } from './types.ts'

export const GAP_BANDS = [
  { below: 10, key: '5–10 min' },
  { below: 30, key: '10–30 min' },
  { below: 60, key: '30–60 min' },
  { below: 480, key: '1–8 h' },
  { below: Infinity, key: '8 h+' },
] as const
export const WHY: Record<string, string> = {
  [CACHE.idle]: 'paused 5 min or more, the cache expired',
  [CACHE.other]: 'first prompt, compaction or changed prefix',
  [CACHE.miss]: 'implicit cache missed (Gemini, xAI, OpenAI)',
}
export const PING_MS = 270_000
export const PING_STOP_MS = 8 * 3_600_000

export type CacheReport = {
  leakUsd: number
  classes: { key: string; responses: number; usd: number; leakUsd: number }[]
  gaps: { key: string; responses: number; leakUsd: number }[]
  pinging: { rewrites: number; pings: number; costUsd: number; savedUsd: number }
  hourCache: { rewrites: number; extraUsd: number; savedUsd: number }
}

export function cache(data: SpendData, filter: Filter): CacheReport {
  const classes = new Map<string, CacheReport['classes'][number]>()
  const gaps = GAP_BANDS.map((band) => ({ key: band.key, responses: 0, leakUsd: 0 }))
  const pinging = { rewrites: 0, pings: 0, costUsd: 0, savedUsd: 0 }
  const hourCache = { rewrites: 0, extraUsd: 0, savedUsd: 0 }
  let leakUsd = 0
  for (const item of itemsIn(data, filter)) {
    const { row } = item
    const spent = amount(item, filter)
    const weight = row.cost.total > 0 ? spent / row.cost.total : 1
    const key = cacheClass(row)
    const lost = leak(row, data.prices) * weight
    let entry = classes.get(key)
    if (!entry) classes.set(key, (entry = { key, responses: 0, usd: 0, leakUsd: 0 }))
    entry.usd += spent
    entry.leakUsd += lost
    leakUsd += lost
    if (row.overhead) continue
    entry.responses += 1
    const input = rate(row, 'input', data.prices)
    const write = rate(row, 'cacheWrite', data.prices)
    const avoided = key === CACHE.idle && row.gapMs !== undefined && row.gapMs < HOUR_MS
    if (!avoided && row.tokens.cacheWrite > 0 && write > input)
      hourCache.extraUsd += row.tokens.cacheWrite * weight * Math.max(0, 2 * input - write)
    if (key !== CACHE.idle || row.gapMs === undefined) continue
    const gap = gaps[GAP_BANDS.findIndex((band) => row.gapMs! / 60_000 < band.below)]
    gap.responses += 1
    gap.leakUsd += lost
    if (row.gapMs < PING_STOP_MS) {
      const pings = Math.floor(row.gapMs / PING_MS)
      pinging.rewrites += 1
      pinging.pings += pings
      pinging.costUsd += pings * prompt(row) * weight * rate(row, 'cacheRead', data.prices)
      pinging.savedUsd += lost
    }
    if (avoided) {
      hourCache.rewrites += 1
      hourCache.savedUsd += lost
    }
  }
  return {
    leakUsd,
    classes: [...classes.values()].toSorted((a, b) => b.leakUsd - a.leakUsd || b.usd - a.usd),
    gaps,
    pinging,
    hourCache,
  }
}

export type CacheLine = {
  key: string
  responses: number
  idle: number
  leakUsd: number
  underHourUsd: number
  model: string
}

export function cacheBy(
  data: SpendData,
  filter: Filter,
  dimension: Exclude<Dimension, 'kind' | 'tool'>,
  top = 5,
): CacheLine[] {
  const lines = new Map<string, CacheLine & { models: Map<string, number> }>()
  for (const item of itemsIn(data, filter)) {
    const { row } = item
    if (row.overhead) continue
    const spent = amount(item, filter)
    const lost = leak(row, data.prices) * (row.cost.total > 0 ? spent / row.cost.total : 1)
    const key = keyOf(row, item.conversation, dimension)
    let line = lines.get(key)
    if (!line)
      lines.set(
        key,
        (line = {
          key,
          responses: 0,
          idle: 0,
          leakUsd: 0,
          underHourUsd: 0,
          model: '',
          models: new Map(),
        }),
      )
    const idle = cacheClass(row) === CACHE.idle
    line.responses += 1
    line.leakUsd += lost
    if (idle) line.idle += 1
    if (idle && row.gapMs !== undefined && row.gapMs < HOUR_MS) line.underHourUsd += lost
    const model = `${row.provider}/${row.model}`
    line.models.set(model, (line.models.get(model) ?? 0) + lost)
  }
  return [...lines.values()]
    .filter((line) => line.leakUsd > 0)
    .toSorted((a, b) => b.leakUsd - a.leakUsd)
    .slice(0, top)
    .map(({ models, ...line }) => ({
      ...line,
      model: [...models].toSorted((a, b) => b[1] - a[1])[0][0],
    }))
}
