/**
 * Conversations in the browser: the overview of what each conversation is about, and the actions that rename,
 * conclude and resume conversations and pick the summary model. Browser-safe.
 */
import { actionRef, docRef } from '../../shared/extension-api.ts'
import { defineEvent } from '../../shared/events.ts'
import type { KeptWork, OverviewState } from './types.ts'

/**
 * Pi compacted conversation `conversation`: its summary is entry `entry`; `reason` is Pi's (`threshold`, `overflow`,
 * `manual`). Emitted in a commit of its own right after Pi's, which has no hook (`compactions.ts`).
 */
export const Compacted = defineEvent<{ conversation: number; entry: number; reason?: string }>(
  'conversations.compacted',
)

/**
 * How full conversation `id`'s context is: `tokens` its next request carries (the latest answer's prompt, or after a
 * compaction or reset an `estimated` count until the next answer), `window` its model's context window and `percent`
 * the two as 0–100. Fields are absent while unknown (no model window, an estimate that failed). `at` is when it was
 * measured (Unix milliseconds: the answer/head message's timestamp, or the estimate time if absent). `entry` is the
 * source assistant or head entry id, used to recover missed updates on open. One per conversation, kept by the server
 * from Pi's answers, compactions, resets and model changes.
 */
export type ContextUsage = {
  tokens?: number
  window?: number
  percent?: number
  estimated?: boolean
  at: number
  entry?: number
}
/** The context fill of a conversation, on that conversation. */
export const ContextDoc = docRef<ContextUsage>('conversations.context')

/** The effective `summaryModel` setting and where it comes from. */
export type SummaryModelSetting = {
  value: unknown
  source: 'default' | 'user' | 'project'
  /** Without a pin: the model family summaries run on (`modelFamilies`). */
  family?: string
  default: string
  /** The project's settings file, when it decides the model. */
  path?: string
}

/** Each conversation's summary, feature, activity and assessment, on conversation 1. */
export const OverviewDoc = docRef<OverviewState>('ultimate.conversation-overview')

/** `{ id, title }` → `{ ok }`: rename top-level conversation `id`; a blank title lets its first message name it again. */
export const RenameAction = actionRef<{ id: number; title: string }, { ok: boolean }>(
  'conversations',
  'rename',
)
/**
 * `{ ids }` → `{ concluded, stopped, previews, kept }`: conclude these conversations, stop the work they and their
 * subagents still run (`stopped` lists the conversations that were busy) and the previews they started (`previews`, by
 * instance id), then free their worktrees; `kept` lists the worktrees kept because they are busy or hold unlanded work.
 * A caller inside a concluded tree is not stopped: it would wait on itself.
 */
export const ConcludeAction = actionRef<
  { ids: number[] },
  { concluded: number[]; stopped: number[]; previews: string[]; kept: KeptWork[] }
>('conversations', 'conclude')
/** `{ ids }` → `{ resumed }`: resume these conversations and their ancestors; `resumed` lists the ones concluded before. */
export const ResumeAction = actionRef<{ ids: number[] }, { resumed: number[] }>(
  'conversations',
  'resume',
)
/** No arguments → the effective summary model setting. */
export const SummaryModelAction = actionRef<null, SummaryModelSetting>(
  'conversations',
  'summaryModel',
)
/**
 * `{ value }` → the new effective setting: set `summaryModel` ("provider/id[:thinking]") in the user's settings, or
 * remove it with `null`. Refuses while the project's settings decide it.
 */
export const SetSummaryModelAction = actionRef<{ value: string | null }, SummaryModelSetting>(
  'conversations',
  'setSummaryModel',
)
