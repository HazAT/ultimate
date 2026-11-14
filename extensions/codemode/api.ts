/**
 * Codemode on the server: the document that keeps a one-line summary of each codemode call, for extensions that write
 * or read it, and the history search other extensions reach codemode's reads through.
 */
import { defineApi } from '../../shared/extension-api.ts'
import { defineDoc } from '@earendil-works/pi-durable'
import { SummariesDoc } from './refs.ts'
import type { Summaries } from './refs.ts'

/** The one-line summaries of a conversation's codemode calls, by call id. */
export const SummaryDoc = defineDoc<Summaries>({
  kind: SummariesDoc.kind,
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'current',
  initial: () => ({ calls: {} }),
})
/**
 * The calls whose summary task still runs in this conversation, so none gets two. A fork starts empty: the task belongs
 * to the source conversation and settles there.
 */
export const PendingDoc = defineDoc<{ calls: string[] }>({
  kind: 'codemode.summaries-pending',
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ calls: [] }),
})

/** One hit of a history search: the conversation and entry it matched, its kind, and about 200 characters of the entry's JSON around the match. */
export type HistoryHit = {
  conversation: number
  id: number
  kind: string
  /** The entry's first model message timestamp, ISO, when it has one. */
  at?: string
  excerpt: string
}

/**
 * Codemode's search over stored conversation history, for extensions that offer a history search of their own (the
 * history-search surface). `want` it: codemode is optional.
 */
export type HistoryService = {
  /** Search this project's stored entries: one conversation with `conversationId`, else every one; at most `limit` (default 100) hits. */
  search(text: string, options?: { conversationId?: number; limit?: number }): Promise<HistoryHit[]>
  /** Search `project`'s stored entries through its running instance, with the URL that answered; undefined when `project` is this one. */
  searchProject(
    project: string,
    text: string,
    options?: { limit?: number },
  ): Promise<{ url: string; hits: HistoryHit[] } | undefined>
}

/** The service other extensions search stored history through. */
export const HistoryApi = defineApi<HistoryService>()('codemode')
