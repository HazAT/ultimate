import type { ConversationId } from '@earendil-works/pi-durable'
import type { ConversationSummary } from '../../shared/protocol.ts'
import type { MemoryItem } from '../lineage/refs.ts'
import type { Todo } from '../todos/refs.ts'
import type { ModelThinkingLevel } from '@earendil-works/pi-ai'
import type { CreateArgs, Schedule } from '../automations/refs.ts'
import type { Question } from '../messages/api.ts'

export type Seed = {
  from: { name: string; number: number }
  learned: string[]
  memories: Record<string, MemoryItem>
  todos: Pick<Todo, 'text' | 'owner'>[]
  questions: { text: string; ref: string; from?: ConversationId; questions?: Question[] }[]
  branches: {
    id: ConversationId
    title: string
    label?: string
    instructions?: string
    model?: { provider: string; modelId: string }
    thinking?: ModelThinkingLevel
    git?: string
    abstract?: string
  }[]
  automations: {
    name: string
    prompt?: string
    subscribers?: string[]
    schedule?: Schedule
    event?: CreateArgs['event']
    condition?: CreateArgs['condition']
    agent?: string
    model?: { provider: string; modelId: string }
    thinking?: ModelThinkingLevel
  }[]
  scripts: {
    id: string
    scope?: 'project'
    name: string
    ask: string
    once?: boolean
    secrets?: string[]
    subscribers?: ConversationId[]
    folder?: string
    prompt?: string
    agent?: string
    model?: { provider: string; modelId: string }
    thinking?: ModelThinkingLevel
  }[]
  counts: {
    memories: number
    todos: number
    questions: number
    automations: number
    scripts: number
    branches?: number
  }
  builtIn?: BuiltInSeed | null
  builtInPause?: BuiltInSeed | null
  continues: { conversation: ConversationId; handoff: string }
}

type BuiltInSeed = { enabled: boolean; condition?: CreateArgs['condition'] }

export const PASSES = ['memory', 'failures', 'tools', 'corrections', 'codify', 'project'] as const
export type PassName = (typeof PASSES)[number]

export function busyElsewhere(conversations: readonly ConversationSummary[]) {
  return conversations
    .filter((item) => item.busy && item.parentConversationId === undefined)
    .map((item) => ({ id: item.id, title: item.title ?? `#${item.id}` }))
}
