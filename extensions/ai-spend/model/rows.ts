import { KINDS } from './types.ts'
import type { Cost, Row, Tokens, ToolShare } from './types.ts'

export type EntryLike = {
  id: number
  conversationId: number
  kind: string
  model?: readonly unknown[]
}
export type UsageBucket = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens?: number
  reasoning?: number
  cost: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    total: number
    totalFromProvider?: boolean
  }
}
export type UsageLike = {
  models?: Record<string, UsageBucket>
  tools?: Record<string, UsageBucket>
}

export const CHARS_PER_TOKEN = 2.5
export const IMAGE_CHARS = 4000
export const REWRITE_SHARE = 0.5
export const IDLE_MS = 5 * 60_000
export const OVERHEAD_MIN_USD = 0.0005
export const TOOLS_PROVIDER = 'tools'
export const TOOLS_MODEL = 'direct'

export type RowState = {
  conversation: number
  last: number
  previous?: { prompt: number; output: number }
  previousAt?: number
  lastAt?: number
  pending: { tool?: string; chars: number }[]
  carried: Map<string, { tokens: number; count: number }>
  rows: Row[]
}

export const createState = (conversation: number): RowState => ({
  conversation,
  last: 0,
  pending: [],
  carried: new Map(),
  rows: [],
})

type Block = {
  type?: string
  text?: unknown
  thinking?: unknown
  name?: unknown
  arguments?: unknown
}
type Message = {
  role?: string
  toolName?: string
  content?: unknown
  provider?: string
  model?: string
  responseModel?: string
  usage?: Partial<UsageBucket>
  timestamp?: number
  durationMs?: number
  thinkingLevel?: string
  providerThinkingLevel?: string
}

const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
const blocks = (content: unknown): Block[] =>
  Array.isArray(content)
    ? (content.filter((block) => block && typeof block === 'object') as Block[])
    : []
const argChars = (block: Block) => JSON.stringify(block.arguments ?? {}).length

export function contentChars(content: unknown): number {
  if (typeof content === 'string') return content.length
  let chars = 0
  for (const block of blocks(content)) {
    if (block.type === 'image') chars += IMAGE_CHARS
    else if (typeof block.text === 'string') chars += block.text.length
    else if (typeof block.thinking === 'string') chars += block.thinking.length
    else if (block.type === 'toolCall') chars += argChars(block)
  }
  return chars
}

const tokensOf = (usage: Partial<UsageBucket>): Tokens => ({
  input: num(usage.input),
  output: num(usage.output),
  cacheRead: num(usage.cacheRead),
  cacheWrite: num(usage.cacheWrite),
  reasoning: num(usage.reasoning),
})
const costOf = (usage: Partial<UsageBucket>): Cost => ({
  input: num(usage.cost?.input),
  output: num(usage.cost?.output),
  cacheRead: num(usage.cost?.cacheRead),
  cacheWrite: num(usage.cost?.cacheWrite),
  total: num(usage.cost?.total),
})
const promptOf = (tokens: Tokens) => tokens.input + tokens.cacheRead + tokens.cacheWrite

export function advance(state: RowState, entries: readonly EntryLike[]): Row[] {
  const added: Row[] = []
  for (const entry of entries.toSorted((a, b) => a.id - b.id)) {
    if (entry.id <= state.last) continue
    state.last = entry.id
    const own = entry.conversationId === state.conversation
    if (entry.kind === 'pi.compaction' || entry.kind === 'pi.reset') {
      state.previous = undefined
      state.pending = []
      state.carried = new Map()
      continue
    }
    const messages = (entry.model ?? []) as Message[]
    const assistant =
      entry.kind === 'pi.assistant'
        ? messages.find((message) => message.role === 'assistant')
        : undefined
    if (!assistant) {
      for (const message of messages) {
        state.pending.push({
          ...(message.role === 'toolResult' && message.toolName ? { tool: message.toolName } : {}),
          chars: contentChars(message.content),
        })
        if (own && typeof (message as { timestamp?: unknown }).timestamp === 'number')
          state.lastAt = Math.max(state.lastAt ?? 0, message.timestamp!)
      }
      continue
    }
    const row = respond(state, assistant, own)
    if (row) added.push(row)
  }
  state.rows.push(...added)
  return added
}

function respond(state: RowState, message: Message, own: boolean): Row | undefined {
  const tokens = tokensOf(message.usage ?? {})
  const prompt = promptOf(tokens)
  const cost = costOf(message.usage ?? {})
  if (prompt <= 0)
    return own && cost.total > 0 ? rowOf(state, message, tokens, cost, new Map()) : undefined
  const jump = state.previous ? prompt - state.previous.prompt - state.previous.output : 0
  const chars = state.pending.reduce((sum, item) => sum + item.chars, 0)
  const addedBy = new Map<string, number>()
  for (const item of state.pending) {
    if (!item.tool) continue
    const size = jump > 0 && chars > 0 ? (jump * item.chars) / chars : item.chars / CHARS_PER_TOKEN
    const carried = state.carried.get(item.tool)
    if (carried) {
      carried.tokens += size
      carried.count += 1
    } else state.carried.set(item.tool, { tokens: size, count: 1 })
    addedBy.set(item.tool, (addedBy.get(item.tool) ?? 0) + 1)
  }
  state.pending = []
  state.previous = { prompt, output: tokens.output }
  if (!own) return undefined

  const carriedTokens = [...state.carried.values()].reduce((sum, item) => sum + item.tokens, 0)
  const scale = carriedTokens > prompt ? prompt / carriedTokens : 1
  const content = blocks(message.content)
  const outputChars = contentChars(content)
  const calls = new Map<string, number>()
  for (const block of content)
    if (block.type === 'toolCall' && typeof block.name === 'string')
      calls.set(block.name, (calls.get(block.name) ?? 0) + argChars(block))
  const promptCost = cost.input + cost.cacheRead + cost.cacheWrite
  const kinds = promptCost + cost.output
  const toTotal = kinds > 0 ? cost.total / kinds : 0
  const tools = new Map<string, ToolShare>()
  for (const name of new Set([...state.carried.keys(), ...calls.keys()])) {
    const carried = state.carried.get(name)
    const share = carried ? (carried.tokens * scale) / prompt : 0
    const outputShare = outputChars > 0 ? (calls.get(name) ?? 0) / outputChars : 0
    tools.set(name, {
      usd: Math.floor((promptCost * share + cost.output * outputShare) * toTotal * 1e9) / 1e9,
      tokens: carried ? Math.round(carried.tokens * scale) : 0,
      carried: carried?.count ?? 0,
      added: addedBy.get(name) ?? 0,
    })
  }
  return rowOf(state, message, tokens, cost, tools)
}

function rowOf(
  state: RowState,
  message: Message,
  tokens: Tokens,
  cost: Cost,
  tools: Map<string, ToolShare>,
): Row {
  const at = num(message.timestamp) || state.lastAt || 0
  const gapMs = state.previousAt === undefined ? undefined : Math.max(0, at - state.previousAt)
  const prompt = promptOf(tokens)
  const rewrite =
    prompt > 0 && tokens.cacheWrite > REWRITE_SHARE * prompt
      ? gapMs !== undefined && gapMs >= IDLE_MS
        ? ('idle' as const)
        : ('other' as const)
      : undefined
  state.previousAt = at
  state.lastAt = Math.max(state.lastAt ?? 0, at)
  const thinking = message.thinkingLevel ?? message.providerThinkingLevel
  return {
    conversation: state.conversation,
    at,
    provider: message.provider ?? '',
    model: message.model ?? '',
    ...(message.responseModel && message.responseModel !== message.model
      ? { served: message.responseModel }
      : {}),
    tokens,
    cost,
    fromProvider: message.usage?.cost?.totalFromProvider === true,
    ...(thinking ? { thinking } : {}),
    ...(message.durationMs !== undefined ? { durationMs: message.durationMs } : {}),
    ...(gapMs !== undefined ? { gapMs } : {}),
    ...(rewrite ? { rewrite } : {}),
    ...(tools.size ? { tools: Object.fromEntries(tools) } : {}),
  }
}

export function splitKey(key: string) {
  const slash = key.indexOf('/')
  return slash < 0
    ? { provider: key, model: '' }
    : { provider: key.slice(0, slash), model: key.slice(slash + 1) }
}

export const usageTotal = (usage: UsageLike | null | undefined) =>
  [...Object.values(usage?.models ?? {}), ...Object.values(usage?.tools ?? {})].reduce(
    (sum, bucket) => sum + num(bucket.cost?.total),
    0,
  )

export function overheadRows(state: RowState, usage: UsageLike | null | undefined): Row[] {
  const at = state.lastAt ?? state.previousAt ?? 0
  const spent = new Map<string, { tokens: Tokens; cost: Cost }>()
  for (const row of state.rows) {
    const key = `${row.provider}/${row.model}`
    const sum = spent.get(key) ?? { tokens: tokensOf({}), cost: costOf({}) }
    for (const kind of KINDS) {
      sum.tokens[kind] += row.tokens[kind]
      sum.cost[kind] += row.cost[kind]
    }
    sum.tokens.reasoning += row.tokens.reasoning
    sum.cost.total += row.cost.total
    spent.set(key, sum)
  }
  const rows: Row[] = []
  for (const [key, bucket] of Object.entries(usage?.models ?? {})) {
    const sum = spent.get(key)
    const cost = costOf(bucket)
    const tokens = tokensOf(bucket)
    if (sum) {
      for (const kind of KINDS) {
        cost[kind] -= sum.cost[kind]
        tokens[kind] = Math.max(0, tokens[kind] - sum.tokens[kind])
      }
      cost.total -= sum.cost.total
      tokens.reasoning = Math.max(0, tokens.reasoning - sum.tokens.reasoning)
    }
    if (cost.total <= OVERHEAD_MIN_USD) continue
    rows.push({
      conversation: state.conversation,
      at,
      ...splitKey(key),
      tokens,
      cost,
      fromProvider: bucket.cost?.totalFromProvider === true,
      overhead: true,
    })
  }
  const tools = Object.entries(usage?.tools ?? {})
  const direct = Object.fromEntries(tools.map(([name, bucket]) => [name, num(bucket.cost?.total)]))
  const tokens = tokensOf({})
  const cost = costOf({})
  for (const [, bucket] of tools) {
    const part = tokensOf(bucket)
    const price = costOf(bucket)
    for (const kind of KINDS) {
      tokens[kind] += part[kind]
      cost[kind] += price[kind]
    }
    tokens.reasoning += part.reasoning
    cost.total += price.total
  }
  if (cost.total > OVERHEAD_MIN_USD)
    rows.push({
      conversation: state.conversation,
      at,
      provider: TOOLS_PROVIDER,
      model: TOOLS_MODEL,
      tokens,
      cost,
      fromProvider: tools.every(([, bucket]) => bucket.cost?.totalFromProvider === true),
      direct,
      overhead: true,
    })
  return rows
}

export const rowsOf = (state: RowState, usage: UsageLike | null | undefined): Row[] => [
  ...state.rows,
  ...overheadRows(state, usage),
]
