import type { ConversationId } from '@earendil-works/pi-durable'
import type { ConversationSummary } from '../../shared/protocol.ts'
import type { MemoryItem } from '../lineage/refs.ts'
import type { Todo } from '../todos/refs.ts'
import type { ModelThinkingLevel } from '@earendil-works/pi-ai'
import type { CreateArgs, Schedule } from '../automations/refs.ts'

/** Everything Fall asleep carries to a fresh chapter; numeric trigger targets and `#id` subscribers need recreating. */
export type Seed = {
  from: { name: string; number: number }
  /** The three lines @ultimate prepared: what it learned. */
  learned: string[]
  memories: Record<string, MemoryItem>
  todos: Pick<Todo, 'text' | 'owner'>[]
  questions: { text: string; ref: string }[]
  automations: {
    name: string
    prompt?: string
    /** The standing agents it wakes, by `@name`: they exist in every chapter. */
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
  }
  /**
   * The built-in "Dream before compaction" automation, recreated in the new chapter as it was; `null` when the user
   * deleted it. Absent in seeds from before it existed: the new chapter makes it.
   */
  builtIn?: { enabled: boolean } | null
  /** The built-in "Dream after a pause" automation, likewise. */
  builtInPause?: { enabled: boolean } | null
  /** @ultimate's handover, written in conversation `conversation` of the chapter it left: the new chapter wakes up from it. */
  continues: { conversation: ConversationId; handoff: string }
}

/** The six passes a dream runs, in the order its journal lists them. */
export const PASSES = ['memory', 'failures', 'tools', 'corrections', 'codify', 'project'] as const
export type PassName = (typeof PASSES)[number]

/**
 * Top-level conversations with a foreground task, @ultimate included: a chapter switch parks whatever is live, and
 * parked work in the chapter left behind keeps it from ever being switched back to.
 */
export function busyElsewhere(conversations: readonly ConversationSummary[]) {
  return conversations
    .filter((item) => item.busy && item.parentConversationId === undefined)
    .map((item) => ({ id: item.id, title: item.title ?? `#${item.id}` }))
}
