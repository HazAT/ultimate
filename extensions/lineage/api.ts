/**
 * Lineage: the project's conversation trees. Roots keep a tally of what happened, branches fork from them for one
 * feature or fix, and notes carry news between conversations without waking them.
 */
import type { ConversationId, EntryId } from '@earendil-works/pi-durable'
import type { Context } from '@earendil-works/chord/context'
import { defineDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { defineApi } from '../../shared/extension-api.ts'
import { RootsDoc, TallyDoc } from './refs.ts'
import type { MemoryItem } from './refs.ts'
import type { BranchInput, leaveNote, rootOf, startBranch, TallyState } from './server.ts'

/** The project's roots, each the top of one conversation tree; a fresh project's first conversation is its first. */
export const Roots = defineDoc<{ roots: ConversationId[] }>({
  kind: RootsDoc.kind,
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ roots: [ROOT_CONVERSATION_ID] }),
})

/** A root's tally bookkeeping (see `TallyDoc`); `since` is set once the root became a tally. */
export const Tally = defineDoc<TallyState>({
  kind: TallyDoc.kind,
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ abstracts: {}, tokens: 0 }),
})

/** `brief`: the branch's context starts at its project's memory brief instead of the full tally. */
export type BranchState = { from: ConversationId; at: EntryId; intent: string; brief?: true }
/**
 * A branch's origin and prompt, written in its forking commit; absent on roots and on conversations made otherwise.
 * Read it to tell a lineage branch from other conversations, before its first run.
 */
export const Branch = defineDoc<{ branch?: BranchState }>({
  kind: 'lineage.branch',
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})

export type LineageService = {
  /** Start a branch from conversation `input.from` with its prompt as first input; returns the new conversation id. */
  branch: (input: BranchInput, ctx: Context) => ReturnType<typeof startBranch>
  /** The root of the tree conversation `id` belongs to, or undefined outside any tree. */
  rootOf: (id: ConversationId, ctx: Context) => ReturnType<typeof rootOf>
  /** Leave `text` in conversation `to` (or the root of the source's tree) for its next turn, without waking it. */
  leaveNote: (
    to: ConversationId | 'root',
    text: string,
    source?: Parameters<typeof leaveNote>[3],
  ) => ReturnType<typeof leaveNote>
  /** Apply memory `ops` to root `root` in one atomic batch, written at `now`; returns what changed. */
  remember: (
    root: ConversationId,
    ops: readonly unknown[],
    ctx: Context,
    now?: number,
  ) => Promise<string>
  /**
   * The memory brief a branch starts from (memory index and recent landings) of conversation `id`'s tree root, else
   * of the project's only root; undefined without either or while it has no memories.
   */
  memoryBrief: (
    id: ConversationId,
    ctx: Context,
  ) => Promise<{ root: ConversationId; text: string; memories: number } | undefined>
  /** The memories of conversation `id`'s tree root, else of the project's only root; undefined without either. */
  memoriesOf: (
    id: ConversationId,
    ctx: Context,
  ) => Promise<{ root: ConversationId; memories: Record<string, MemoryItem> } | undefined>
}
export { Branched, Rooted } from './refs.ts'

export type MemorySearchService = {
  /** The slugs of `memories` that `query` is about, best first, at most five; throws when no search is possible. */
  search(
    query: string,
    memories: Record<string, MemoryItem>,
    signal: AbortSignal,
  ): Promise<string[]>
}
/** The extension point the `memory` tool's `query` searches through; recall provides it with classify. */
export const MemorySearch = defineApi<MemorySearchService>()('lineage.memory-search')

/** Trees, branches and notes; core, so `need` it. */
export const LineageApi = defineApi<LineageService>()('lineage')
export const tier = 'core'
