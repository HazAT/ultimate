import type { ConversationId } from '@earendil-works/pi-durable'
import { defineWebExtension, provide } from '@/sdk'
import { ConversationPhase } from '../conversations/ui.tsx'
import { PhaseLabel, phaseText, usePhase } from './ui.tsx'

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
