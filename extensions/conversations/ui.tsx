/**
 * Conversations for other extensions' browser code: references to conversations with their features, agent marks,
 * the primary agent, which conversations a conclusion hides, the overview document and the conversation actions, and
 * the points where optional extensions describe a conversation (its working phase, its plan task).
 */
import type { ConversationId } from '@earendil-works/pi-durable'
import type { ReactNode } from 'react'
import { definePoint, useUiState } from '@/sdk'

/**
 * What a working conversation `id` is doing (`phase` provides it): `label` for a row's activity line, `word` in lower
 * case in place of "working", and whether it only `waiting` on its subagents. Undefined while not known.
 */
export const ConversationPhase = definePoint<
  ConversationId | undefined,
  { label: ReactNode; word: string; waiting: boolean } | undefined
>('conversations.phase')
/** Whether conversation `id` gets no summaries, so its transcript hides older summary lines (lineage: a root). */
export const Unsummarized = definePoint<ConversationId, boolean>('conversations.unsummarized')
/** The plan task conversation `id` works on (`plan` provides it): its chip and title. */
export const ConversationTask = definePoint<
  ConversationId | undefined,
  { chip: ReactNode; title: string } | undefined
>('conversations.task')
/**
 * The epic coordinator `id` works itself (`plan` provides it): its newest open epic, else its newest, when none of its
 * tasks went to a subagent; `open` shows it in the plan panel.
 */
export const ConversationEpic = definePoint<
  ConversationId,
  { key: string; title: string; status: string; open: () => void } | undefined
>('conversations.epic')

export { ConversationRef, FeatureTag, useOverview, useStandingName } from './feature.tsx'
export { AgentMark, AgentTitle, useAgentTitle } from './marks.tsx'
export type { Presence } from './marks.tsx'
export { hiddenConversationIds } from './visible.tsx'

/**
 * Since when each conversation counts as concluded: forever while it is, else when it was last concluded (kept when
 * it is resumed); undefined for one never concluded. What it said before then is settled.
 */
export function useConcludedSince(): (id: ConversationId) => number | undefined {
  const [concluded] = useUiState<ConversationId[]>('ext.conversations.concluded', [])
  const [at] = useUiState<Record<string, number>>('ext.conversations.concludedAt', {})
  return (id) => (concluded.includes(id) ? Infinity : at[id])
}
export {
  Compacted,
  ConcludeAction,
  ContextDoc,
  OverviewDoc,
  RenameAction,
  ResumeAction,
  SummariesAction,
} from './refs.ts'
