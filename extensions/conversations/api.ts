/**
 * Conversations: titles, summaries, the summary model and concluding conversations. Other extensions read what a
 * conversation is about and ask the summary model through this service.
 */
import type { ConversationId, SubmissionDraft, Tx } from '@earendil-works/pi-durable'
import type { Context } from '@earendil-works/chord/context'
import { defineDoc } from '@earendil-works/pi-durable'
import { defineApi } from '../../shared/extension-api.ts'
import { ContextDoc, MarksDoc, OverviewDoc } from './refs.ts'
import type { AgentMarkStyle, ContextUsage } from './refs.ts'
import type { ConversationSubject, KeptWork, OverviewState } from './types.ts'
import type {
  accountResponse,
  askSummaryModel,
  setAutomaticSummaries,
  SummaryRequest,
} from './summary.ts'
import type { SummaryModel, SummaryModelStatus } from './summary-model.ts'

export type ConversationsService = {
  /** What conversation `id` is about now: its title, summary and feature, for a record that outlives a retitle. */
  subject: (id: ConversationId, caller: Context) => Promise<ConversationSubject>
  /** The conversations the user concluded; use it to leave their resources (worktrees) alone or free them. */
  concluded: (caller: Context) => Promise<Set<ConversationId>>
  /** Read concluded conversations inside `tx`, including its pending changes. */
  concludedIn(tx: Tx): Promise<Set<ConversationId>>
  /**
   * Conclude top-level conversations `ids` inside `tx`, as the Conclude action does before it frees their resources
   * through `Release`; throws for unknown and owned conversations, roots and standing agents. Returns them with every
   * conversation they own, as the `Concluded` event it emits lists them.
   */
  concludeIn(
    tx: Tx,
    ids: ConversationId[],
    by: ConversationId | 'landing' | 'user',
  ): Promise<Set<ConversationId>>
  /** The summary model to ask now, from settings; undefined while none is valid and available. */
  summaryModel(): Promise<SummaryModel | undefined>
  /** The summary model with why: the configured one, a fallback for a default without a login, or why none runs. */
  summaryModelStatus(): Promise<SummaryModelStatus>
  /** Request a summary of `id` inside the trigger's transaction, with the model resolved before it. */
  requestSummary(
    tx: Tx,
    id: ConversationId,
    request: SummaryRequest,
    model: SummaryModel | undefined,
  ): Promise<void>
  /**
   * Inside `tx`, turn conversation `id`'s automatic summaries (intent, reply and spawn triggers) on or off; its title
   * then stays as set. Off for standing agents, landers, side chats and definitions with `summaries: false`.
   */
  setAutomaticSummaries: typeof setAutomaticSummaries
  /**
   * Inside `tx`, mark conversation `id` a standing agent, a fixed part of the project that is never concluded, or
   * (`false`) an ordinary conversation again. Subagents sets it on residents, workspaces on landers.
   */
  setStanding(tx: Tx, id: ConversationId, standing: boolean): Promise<void>
  /** Ask a summary model once with a system prompt and input, or return the response the receipt already holds. */
  askSummaryModel: typeof askSummaryModel
  /** Add a summary model response's usage to the conversation's `pi.usage` inside `tx`, after asking. */
  accountResponse: typeof accountResponse
  /**
   * Inside `tx`, mark `title` of a new conversation `id` (a branch or root named by its intent) as generated, so its
   * summary may replace it; a no-op once a rename or summary chose another title.
   */
  generatedTitle(tx: Tx, id: ConversationId, title: string): Promise<void>
  /**
   * Inside `tx`, have `draft` submitted to conversation `to` right after the commit: for a commit that cannot admit it
   * with `submit(tx, draft)` itself, as it created `to`, wrote a table first or holds no handle of `to`. An input keeps
   * `to` busy until it is admitted.
   */
  submitAfter(tx: Tx, to: ConversationId, draft: SubmissionDraft): Promise<void>
}
export type TreesService = {
  /** Whether conversation `id` is one of the project's roots, read inside `tx`. */
  isRoot(tx: Tx, id: ConversationId): Promise<boolean>
  /** The root of the tree conversation `id` belongs to, or undefined outside any tree. */
  rootOf(id: ConversationId, ctx: Context): Promise<number | undefined>
  /** The root whose tally lists top-level conversation `id`, with its branch intent; undefined for roots and others. */
  branchOf(
    id: ConversationId,
    ctx: Context,
  ): Promise<{ root: ConversationId; intent?: string } | undefined>
  /**
   * Write the abstract of conversation `id` into its tree root's tally inside `tx`, before the transaction's first
   * entry; a no-op outside a tree.
   */
  abstract(
    tx: Tx,
    id: ConversationId,
    input: { text: string; at: number; title?: string; feature?: string },
  ): Promise<void>
}
/**
 * The extension point through which summaries know a conversation's tree: a root's feature names its whole tree, and
 * a branch's summary writes its abstract into the tally. Lineage provides it.
 */
export const Trees = defineApi<TreesService>()('conversations.trees')
export type ReleaseService = {
  /** Free what concluded conversations `ids` and their owned descendants hold; returns the work kept, and why. */
  release(ids: ConversationId[], caller: Context): Promise<KeptWork[]>
}
/** The extension point concluding frees resources through; workspaces provides it (worktrees). */
export const Release = defineApi<ReleaseService>()('conversations.release')
export type PreviewsService = {
  /** Stop the previews conversations `ids` started (each listed, descendants included); returns their instance ids. */
  stop(ids: ConversationId[], caller: Context): Promise<string[]>
}
/** The extension point the Conclude action stops previews through; instance provides it. */
export const Previews = defineApi<PreviewsService>()('conversations.previews')
/**
 * How full a conversation's context is, on that conversation: the one measure the status line and automations' context
 * triggers read. The conversations extension keeps it; a fork starts empty until its first answer.
 */
export const ContextUsageDoc = defineDoc<ContextUsage>({
  kind: ContextDoc.kind,
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ at: 0 }),
})
export type { ContextUsage } from './refs.ts'
/** Each conversation's run state, summary and feature, on conversation 1; the sidebar and notifications read it. */
export const Overview = defineDoc<OverviewState>({
  kind: OverviewDoc.kind,
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ conversations: {} }),
})
export { Concluded } from './refs.ts'
/** How each standing agent's mark looks, on conversation 1; subagents writes it from the definitions. */
export const Marks = defineDoc<Record<string, AgentMarkStyle>>({
  kind: MarksDoc.kind,
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})
/** Conversation subjects and the summary model; core, so `need` it. */
export const ConversationsApi = defineApi<ConversationsService>()('conversations')
export const tier = 'core'
