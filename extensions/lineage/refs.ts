/**
 * Lineage in the browser: the project's roots, each root's tally size, the actions behind a root's sidebar row and
 * landing cards, and the branch and root events. Browser-safe.
 */
import type { TaskId, ConversationId, EntryId } from '@earendil-works/pi-durable'
import { actionRef, docRef } from '../../shared/extension-api.ts'
import { defineEvent } from '../../shared/events.ts'
import type { RootEvent } from './types.ts'

/** `{ roots }` on conversation 1: the project's roots, each the top of one conversation tree. */
export const RootsDoc = docRef<{ roots: ConversationId[] }>('lineage.roots')
/**
 * A root's tally bookkeeping on the root itself: `tokens`, the estimated size of its model-visible context,
 * `briefTokens`, that of the memory brief a branch starts from (absent while it has no memories), and `since`, the
 * entry it became a tally at (absent while it is an ordinary conversation).
 */
export const TallyDoc = docRef<{ tokens: number; briefTokens?: number; since?: EntryId }>(
  'lineage.tally',
)

/** One project memory: a durable decision, fact or lesson a future branch needs. */
export type MemoryItem = {
  kind: 'decision' | 'fact' | 'lesson'
  /** One line, at most 120 characters: what the index shows. */
  line: string
  /** The full memory, at most 2000 characters. */
  body: string
  /** Where it was learned, `#<conversation>/<entry>`. */
  source?: string
  /** When it was last written, epoch ms. */
  updated: number
}
/** `{ memories }` on a root: its project memory by slug (`^[a-z0-9][a-z0-9-]{0,47}$`), at most 150. */
export const MemoryDoc = docRef<{ memories: Record<string, MemoryItem> }>('lineage.memory')
/** `{ root, slug }` → `{ summary }`: delete memory `slug` of root `root`. User-only. */
export const ForgetAction = actionRef<{ root: ConversationId; slug: string }, { summary: string }>(
  'lineage',
  'forget',
)

/**
 * `{ id, limit?, types? }` → the newest events of root `id` (landings, notes, branches, compactions), newest first:
 * `limit` defaults to 3, at most 20, only of `types` when given. Landings on a GitHub `origin` carry a compare link.
 */
export const RecentAction = actionRef<
  { id: ConversationId; limit?: number; types?: RootEvent['type'][] },
  RootEvent[]
>('lineage', 'recent')
/**
 * No arguments → opens the project folder in Zed on the machine Ultimate runs on (`zeditor`, else `zed`, on PATH).
 * Refused when neither is installed. User-only.
 */
export const OpenEditorAction = actionRef<null, { editor: string }>('lineage', 'openEditor')
/** `{ id, instructions? }` → `{ taskId }`: compact root `id`'s tally, for its history footer and the palette. */
export const CompactAction = actionRef<
  { id: ConversationId; instructions?: string },
  { taskId: TaskId }
>('lineage', 'compact')

/**
 * A file the set-aside path touched (a commit or an edit or write after the entry) as it is in the checkout now: lines
 * added and removed since the entry's tip, new and untracked, outside the checkout (an absolute path Git cannot count),
 * or none of these when Git shows no difference to count.
 */
export type RewindFile = {
  path: string
  added?: number
  removed?: number
  untracked?: true
  outside?: true
}
/** A conversation that built on the path a go-back set aside: a subagent or branch it started, or one it messaged. */
export type RewindDependent = { id: ConversationId; via: 'subagent' | 'branch' | 'message' }
/** What going back to an entry would set aside and leave in the checkout; `refused` says why it cannot now. */
export type RewindPreview = {
  refused?: string
  /** Entries after the point that leave the model's context. */
  steps: number
  files: RewindFile[]
  commits: { sha: string; subject: string }[]
  dependents: RewindDependent[]
  /** Whether a summary model can summarize the set-aside path. */
  summaryModel: boolean
}
/** `{ conversation, at }` → what going back to entry `at` of `conversation` sets aside, or why it cannot. */
export const RewindPreviewAction = actionRef<
  { conversation: ConversationId; at: EntryId },
  RewindPreview
>('lineage', 'rewindPreview')
/**
 * `{ conversation, at, summarize? }` → `{ entry }`: go back to entry `at` in place. Everything after it leaves the model's
 * context (still shown, folded), and one note entry says what changed in the checkout since, with a summary of the
 * set-aside path when `summarize`. Starts no turn. User-only.
 */
export const RewindAction = actionRef<
  { conversation: ConversationId; at: EntryId; summarize?: boolean },
  { entry: EntryId }
>('lineage', 'rewind')
/** `conversation` went back to entry `at`; `entry` is its note, `dependents` the conversations that built on the path. */
export const Rewound = defineEvent<{
  conversation: ConversationId
  at: EntryId
  entry: EntryId
  dependents: ConversationId[]
}>('lineage.rewound')

/**
 * A branch started: conversation `id` forked from `from` at entry `at`, its prompt `intent` and, when its starter gave
 * one, its `title`. Emitted in the forking commit, before the branch's first run; react to it to set up a new branch's
 * own state.
 */
export const Branched = defineEvent<{
  id: ConversationId
  from: ConversationId
  at: EntryId
  intent: string
  title?: string
}>('lineage.branched')
/** A root was created: conversation `id`, titled `intent`. Emitted in the creating commit. */
export const Rooted = defineEvent<{ id: ConversationId; intent: string }>('lineage.rooted')
