/**
 * Plan: a coordinator's durable epics and tasks. Other extensions read the acceptance criteria its newest open epic
 * still has unconfirmed, and record estimates of how far the work on each looks.
 */
import type { Context } from '@earendil-works/chord/context'
import type { ConversationId, Tx } from '@earendil-works/pi-durable'
import { defineApi } from '../../shared/extension-api.ts'
import type { Estimate } from './refs.ts'

/** A criterion the coordinator has not confirmed: its 1-based number, its text and its estimate so far. */
export type OpenCriterion = { n: number; text: string; estimate?: Estimate['state'] }

export type PlanService = {
  /**
   * The unconfirmed acceptance criteria of conversation `id`'s newest open epic when it works that epic without tasks;
   * undefined when there are none.
   */
  openCriteria(
    id: ConversationId,
    caller: Context,
  ): Promise<{ epic: string; criteria: OpenCriterion[] } | undefined>
  /**
   * Inside `tx`, raise the estimates of epic `epic` on conversation `id`, keyed by criterion text: an estimate only moves
   * up, and texts no longer among the epic's criteria are dropped.
   */
  estimate(
    tx: Tx,
    id: ConversationId,
    epic: string,
    estimates: Record<string, Estimate>,
  ): Promise<void>
}
/** Acceptance criteria and their estimates; `want` it, plan is optional. */
export const PlanApi = defineApi<PlanService>()('plan')
