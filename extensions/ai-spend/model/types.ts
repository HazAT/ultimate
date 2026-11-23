export const KINDS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const
export type Kind = (typeof KINDS)[number]
export type Tokens = Record<Kind, number> & { reasoning: number }
export type Cost = Record<Kind, number> & { total: number }

export type ToolShare = {
  usd: number
  tokens: number
  carried: number
  added: number
}

export type Row = {
  conversation: number
  at: number
  provider: string
  model: string
  served?: string
  tokens: Tokens
  cost: Cost
  fromProvider: boolean
  thinking?: string
  durationMs?: number
  gapMs?: number
  rewrite?: 'idle' | 'other'
  tools?: Record<string, ToolShare>
  direct?: Record<string, number>
  overhead?: true
}

export type Conversation = {
  id: number
  title: string
  agent: string
  label?: string
  family: string | null
  owner?: number
  parent?: number
  root: number
  busy: boolean
  concluded: boolean
  usage: number
  live: boolean
  ref?: string
}

export const refOf = (conversation: Conversation) => conversation.ref ?? `#${conversation.id}`

export type Price = Record<Kind, number>

export type Snapshot = {
  epoch: string
  version: number
  since: number | null
  conversations: Conversation[]
  rows: Record<number, { from: number; rows: Row[] }>
  prices: Record<string, Price>
}

export type SpendData = {
  epoch: string
  version: number
  since: number | null
  conversations: Conversation[]
  rows: Row[]
  prices: Record<string, Price>
}

export type SnapshotArgs = { version: number; epoch: string } | null
