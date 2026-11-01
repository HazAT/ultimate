import { cn, formatAgo } from '@/sdk'
import { stateTone, stateWord } from '../messages/ui.tsx'
import type { ConversationState } from '../messages/ui.tsx'
import type { useWorkspaceIndex } from '../workspaces/ui.tsx'

/**
 * The lander's line: a pulsing "landing" while it lands, else its conversation state; then how many submissions wait
 * in its queue and when it last landed. What landed is its Landed section's first row.
 */
export function LanderState({
  id,
  index,
  now,
  state,
}: {
  id: number
  index: ReturnType<typeof useWorkspaceIndex>
  now: number
  state: ConversationState
}) {
  const source = Object.entries(index.landerConversations).find(([, lander]) => lander === id)?.[0]
  const landing = index.queue.some((item) => item.source === source && item.state === 'landing')
  const queued = index.queue.filter(
    (item) => item.source === source && item.state === 'queued',
  ).length
  const last = Object.values(index.results).findLast((result) => result.lander === id && result.sha)
  const at = last?.steps.at(-1)?.at
  return (
    <>
      {landing ? (
        <span className="shrink-0 text-brand">landing</span>
      ) : (
        <span className={cn('shrink-0', stateTone[state])}>{stateWord(state)}</span>
      )}
      {queued > 0 && <span className="shrink-0 text-foreground/80">queue {queued}</span>}
      {at !== undefined && (
        <span
          className="ml-auto shrink-0 text-muted-foreground"
          title={new Date(at).toLocaleString()}
        >
          {formatAgo(at, now)}
        </span>
      )}
    </>
  )
}
