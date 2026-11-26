/**
 * Codemode on the server: the document that keeps a one-line summary of each codemode call, for extensions that write
 * or read it.
 */
import { defineDoc } from '@earendil-works/pi-durable'
import { SummariesDoc } from './refs.ts'
import type { Summaries } from './refs.ts'
import { checkpointEvery } from '../../shared/checkpoint.ts'

/** The one-line summaries of a conversation's codemode calls, by call id. */
export const SummaryDoc = defineDoc<Summaries>({
  kind: SummariesDoc.kind,
  checkpointWhen: checkpointEvery(100),
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
  checkpointWhen: checkpointEvery(100),
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ calls: [] }),
})
