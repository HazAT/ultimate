import type { ConversationId } from '@earendil-works/pi-durable'
import { useStandingName } from './feature.tsx'
import { standingPlaceholder, useAgentTitle } from './marks.tsx'

export function useStandingPlaceholder({
  conversation,
  busy,
}: {
  conversation: ConversationId
  busy: boolean
}) {
  const name = useStandingName(conversation)?.replace(/^@/, '')
  return standingPlaceholder(name, useAgentTitle(name ?? '').title, busy)
}
