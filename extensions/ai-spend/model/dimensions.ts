import { dayKey, hourKey, startOfWeek } from './calendar.ts'
import { KINDS } from './types.ts'
import type { Conversation, Row } from './types.ts'

export const DIMENSIONS = {
  conversation: 'Conversation',
  tree: 'Tree',
  agent: 'Agent',
  model: 'Model',
  provider: 'Provider',
  vendor: 'Vendor',
  family: 'Family',
  kind: 'Token kind',
  thinking: 'Thinking',
  cache: 'Cache',
  prompt: 'Prompt size',
  status: 'Status',
  tool: 'Tool',
  hour: 'Hour of day',
  day: 'Day',
  week: 'Week',
} as const
export type Dimension = keyof typeof DIMENSIONS
export const SPLIT: ReadonlySet<Dimension> = new Set(['kind', 'tool'])

export const NO_TOOL = '(no tool)'
export const OVERHEAD = '(overhead)'
export const OTHER = 'other'
export const PINNED = '(pinned)'
export const NO_THINKING = '(none)'
export const SHOPIFY_PROXY = 'Shopify proxy'

export const CACHE = {
  hit: 'hit',
  idle: 'idle rewrite',
  other: 'first/changed',
  miss: 'miss',
  partial: 'partial',
  small: 'uncached',
} as const
export const MISS_MIN_TOKENS = 8_000
export const PROMPT_BANDS = [
  { below: 50_000, key: '<50k' },
  { below: 100_000, key: '50–100k' },
  { below: 200_000, key: '100–200k' },
  { below: Infinity, key: '200k+' },
] as const

export type Part = { key: string; usd: number; tokens: number }
export type Filter = { from?: number; to?: number } & Partial<Record<Dimension, string[]>>

export const vendor = (provider: string, model: string) =>
  provider === 'proxy' || model.startsWith('shopify/') ? SHOPIFY_PROXY : provider

export const total = (row: Row) =>
  row.tokens.input + row.tokens.output + row.tokens.cacheRead + row.tokens.cacheWrite
export const prompt = (row: Row) => row.tokens.input + row.tokens.cacheRead + row.tokens.cacheWrite

export function cacheClass(row: Row): string {
  if (row.overhead) return OVERHEAD
  if (row.rewrite === 'idle') return CACHE.idle
  if (row.rewrite === 'other') return CACHE.other
  const size = prompt(row)
  if (size > 0 && row.tokens.cacheRead >= size / 2) return CACHE.hit
  if (size < MISS_MIN_TOKENS) return CACHE.small
  return row.tokens.cacheWrite === 0 && row.tokens.input > size / 2 ? CACHE.miss : CACHE.partial
}

const promptBand = (row: Row) =>
  row.overhead ? OVERHEAD : PROMPT_BANDS.find((band) => prompt(row) < band.below)!.key

export const bandOrder = (key: string) => {
  const at = PROMPT_BANDS.findIndex((band) => band.key === key)
  return at < 0 ? PROMPT_BANDS.length : at
}

const status = (conversation: Conversation) =>
  !conversation.live
    ? 'earlier chapter'
    : conversation.busy
      ? 'busy'
      : conversation.concluded
        ? 'concluded'
        : 'open'

export function keyOf(row: Row, conversation: Conversation, dimension: Dimension): string {
  switch (dimension) {
    case 'conversation':
      return String(row.conversation)
    case 'tree':
      return String(conversation.root)
    case 'agent':
      return conversation.agent
    case 'model':
      return `${row.provider}/${row.model}`
    case 'provider':
      return row.provider
    case 'vendor':
      return vendor(row.provider, row.model)
    case 'family':
      return conversation.family ?? PINNED
    case 'thinking':
      return row.thinking ?? NO_THINKING
    case 'cache':
      return cacheClass(row)
    case 'prompt':
      return promptBand(row)
    case 'status':
      return status(conversation)
    case 'hour':
      return hourKey(row.at)
    case 'day':
      return dayKey(row.at)
    case 'week':
      return dayKey(startOfWeek(row.at))
    case 'kind':
    case 'tool':
  }
  return ''
}

export function parts(row: Row, conversation: Conversation, dimension: Dimension): Part[] {
  if (dimension === 'kind') {
    const kinds = KINDS.reduce((sum, kind) => sum + row.cost[kind], 0)
    if (kinds <= 0) return [{ key: 'unsplit', usd: row.cost.total, tokens: total(row) }]
    return KINDS.map((kind) => ({
      key: kind,
      usd: (row.cost[kind] * row.cost.total) / kinds,
      tokens: row.tokens[kind],
    }))
  }
  if (dimension === 'tool') {
    const out: Part[] = []
    let usd = 0
    let tokens = 0
    if (row.overhead) {
      for (const [name, spent] of Object.entries(row.direct ?? {})) {
        out.push({ key: name, usd: spent, tokens: 0 })
        usd += spent
      }
    } else
      for (const [name, share] of Object.entries(row.tools ?? {})) {
        out.push({ key: name, usd: share.usd, tokens: share.tokens })
        usd += share.usd
        tokens += share.tokens
      }
    out.push({
      key: row.overhead ? OVERHEAD : NO_TOOL,
      usd: row.cost.total - usd,
      tokens: Math.max(0, total(row) - tokens),
    })
    return out
  }
  return [{ key: keyOf(row, conversation, dimension), usd: row.cost.total, tokens: total(row) }]
}
