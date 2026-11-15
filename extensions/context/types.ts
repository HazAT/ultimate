import type { ImageContent, TextContent } from '@earendil-works/pi-ai'
import type { EntryRecord } from '@earendil-works/pi-durable'

type EstimatedTokens = number
type ContextFirstResponseModel = { provider: string; model: string; thinking?: string }

export interface Section {
  key: string
  text: string
  tokens: EstimatedTokens
}
export interface Tool {
  name: string
  description: string
  parameters: unknown
  tokens: EstimatedTokens
}
export interface Prompt {
  sections: Section[]
  tools: Tool[]
}
export interface Injected {
  label: string
  entry?: EntryRecord
  content: string | readonly (TextContent | ImageContent)[]
  tokens: EstimatedTokens
}
export interface Breakdown {
  start?: EntryRecord
  injected?: Injected
  system?: EntryRecord
  prompt?: Prompt
  model?: ContextFirstResponseModel
  tokens: { prompt: number; tools: number; injected: number; total: number }
}
export interface SectionChange {
  key: string
  change: 'added' | 'changed' | 'removed'
  text: string
  before?: string
  delta: number
}
export interface ToolChange {
  name: string
  change: 'added' | 'changed' | 'removed'
  tool: Tool
  delta: number
}
export interface Diff {
  sections: SectionChange[]
  tools: ToolChange[]
  delta: number
}
