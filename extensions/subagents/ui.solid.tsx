/** @jsxImportSource @solidjs/web */
/** Subagents for Solid code: a child's display name and opening the primary standing agent. */
import { api, writerNow, writingAs } from '@/sdk/solid'
import type { UltimateActions } from '@/sdk'
import { StandingAction } from './refs.ts'

/** A child's label, the model it started on, and a wand if it was made without a definition. */
export { RunName } from './run-name.solid.tsx'

/**
 * A quiet mark another extension shows at the end of an agent definition's row in the Agents panel (`name` is the
 * definition's name), before its move menu. Provide it as `island(C)`.
 */
export { AgentMark } from './points.ts'

/** Open the primary agent's standing conversation on the Agent surface. */
export async function talkToUltimate(
  actions: Pick<UltimateActions, 'switchConversation' | 'showSurface'>,
) {
  const who = writerNow()
  const id = await api.action(StandingAction, { name: 'ultimate' })
  writingAs(who, () => {
    actions.switchConversation(id)
    actions.showSurface('agent')
  })
}
