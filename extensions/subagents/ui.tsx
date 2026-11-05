/**
 * Subagents for other extensions' browser code: opening the message that started an agent, the standing agents and
 * talking to the primary one, and the agent definitions.
 */
import { WandSparklesIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { api, events, useDocOf } from '@/sdk'
import type { UltimateActions } from '@/sdk'
import { RunsDoc, StandingAction } from './refs.ts'
import type { Run } from './refs.ts'

export { DefinitionAction, DefinitionsAction, StandingAction, StandingDoc } from './refs.ts'

/** What child `id` was started on, its model id and whether it was made on the fly; undefined for other conversations. */
export function useRun(id: number | undefined): Run | undefined {
  const runs = useDocOf(1, RunsDoc)
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
      {run?.model && <span className="text-muted-foreground"> · {run.model}</span>}
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
  switchConversation: (id: number) => void,
  source: { conversation: number; entry?: number },
  receiver: { conversation: number; entry?: number },
) {
  events.emit('subagents:source', { target: source, back: receiver })
  switchConversation(source.conversation)
}
