import type { ConversationId } from '@earendil-works/pi-durable'
import { defineWebExtension, provide } from '@/sdk'
import { ConversationPhase } from '../conversations/ui.tsx'
import { PhaseLabel, phaseText, usePhase } from './ui.tsx'

/** A working conversation's phase for the sidebar: its label, its word, and whether it only waits on subagents. */
function useConversationPhase(id: ConversationId | undefined) {
  const phase = usePhase(id)
  return (
    phase && {
      label: <PhaseLabel phase={phase} />,
      word: phaseText(phase).toLowerCase(),
      waiting: phase === 'waiting',
    }
  )
}
export default defineWebExtension({
  provides: [provide(ConversationPhase, useConversationPhase)],
})
