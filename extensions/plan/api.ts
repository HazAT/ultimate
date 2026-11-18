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
   * The unconfirmed acceptance criteria of conversation `id`'s newest open epic and the `revision` of its criteria;
   * undefined when there are none.
   */
  openCriteria(
    id: ConversationId,
    caller: Context,
  ): Promise<{ epic: string; revision: number; criteria: OpenCriterion[] } | undefined>
  /**
   * Inside `tx`, raise the estimates of epic `epic` on conversation `id`, keyed by criterion text, unless its criteria
   * changed since `revision` (what `openCriteria` returned): an estimate only moves up.
   */
  estimate(
    tx: Tx,
    id: ConversationId,
    epic: string,
    revision: number,
    estimates: Record<string, Estimate>,
  ): Promise<void>
}
/** Acceptance criteria and their estimates; `want` it, plan is optional. */
export const PlanApi = defineApi<PlanService>()('plan')
