/**
 * Subagents for other extensions' browser code: opening the message that started an agent, the standing agents and
 * talking to the primary one, and the agent definitions.
 */
export { InstructionEntry, ReportEntry } from './refs.ts'

import type { ConversationId } from '@earendil-works/pi-durable'
import { ROOT } from '@/sdk'
import { WandSparklesIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { api, events, useDocOf } from '@/sdk'
import type { UltimateActions } from '@/sdk'
import { RunsDoc, StandingAction } from './refs.ts'
import type { Run } from './refs.ts'
import { agentSource } from './source.ts'
import type { Destination } from './source.ts'

export {
  DefinitionAction,
  DefinitionsAction,
  RunsDoc,
  StandingAction,
  StandingDoc,
} from './refs.ts'

/** The model and definition or ad hoc flag of child `id`; undefined for other conversations. */
export function useRun(id: number | undefined): Run | undefined {
  const runs = useDocOf(ROOT, RunsDoc)
  return id === undefined ? undefined : runs?.[String(id)]
}

/**
 * A child's name as rows and cards show it: its label, then the model it was started on, muted, and a wand when
 * `subagent start` made it on the fly rather than from a definition.
 */
export function RunName({ id, label }: { id: number | undefined; label: ReactNode }) {
  const run = useRun(id)
  return (
    <>
      {run?.adhoc && (
        <WandSparklesIcon
          aria-label="Made on the fly"
          className="mr-1 inline size-3 shrink-0 align-[-2px] text-muted-foreground"
        >
          <title>Made on the fly, without a definition</title>
        </WandSparklesIcon>
      )}
      {label}
      {run?.model && <span className="text-muted-foreground/70"> · {run.model}</span>}
    </>
  )
}

/** Show the primary agent's standing conversation on the Agent surface: @ultimate starts branches and keeps tallies. */
export async function talkToUltimate(
  actions: Pick<UltimateActions, 'switchConversation' | 'showSurface'>,
) {
  const id = await api.action(StandingAction, { name: 'ultimate' })
  actions.switchConversation(id)
  actions.showSurface('agent')
}

/** Show `source`, where an agent's message came from, with a way back to `receiver`, where it arrived. */
export function openAgentSource(
  switchConversation: (id: ConversationId) => void,
  source: Destination,
  receiver: Destination,
) {
  agentSource(events)(switchConversation, source, receiver)
}
