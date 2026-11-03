import type { ImageContent, TextContent } from '@earendil-works/pi-ai'
import type { EntryRecord } from '@earendil-works/pi-durable'

/** A prompt section as the model saw it, with its estimated tokens. */
export interface Section {
  key: string
  text: string
  tokens: number
}
/** A tool declaration as the model saw it; its tokens estimate the declaration's JSON. */
export interface Tool {
  name: string
  description: string
  parameters: unknown
  tokens: number
}
/** The system prompt and tools in effect at an entry, in request order. */
export interface Prompt {
  sections: Section[]
  tools: Tool[]
}
/** What a context start put in front of the model before its prompt: a memory brief, a tally, a summary, a handoff. */
export interface Injected {
  label: string
  entry?: EntryRecord
  content: string | readonly (TextContent | ImageContent)[]
  tokens: number
}
/** What the model saw before the first input of a context, part by part. */
export interface Breakdown {
  /** The context's start marker; absent for a conversation's own start. */
  start?: EntryRecord
  injected?: Injected
  /** The first system prompt of the context; absent until its first request. */
  system?: EntryRecord
  prompt?: Prompt
  /** The model and thinking level of the context's first response. */
  model?: { provider: string; model: string; thinking?: string }
  tokens: { prompt: number; tools: number; injected: number; total: number }
}
export interface SectionChange {
  key: string
  change: 'added' | 'changed' | 'removed'
  /** The new text, or the removed one. */
  text: string
  /** A changed section's text before. */
  before?: string
  delta: number
}
export interface ToolChange {
  name: string
  change: 'added' | 'changed' | 'removed'
  tool: Tool
  delta: number
}
/** How the prompt and tools changed between two states. */
export interface Diff {
  sections: SectionChange[]
  tools: ToolChange[]
  delta: number
}
