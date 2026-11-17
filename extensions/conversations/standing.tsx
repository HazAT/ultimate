import type { ConversationId } from '@earendil-works/pi-durable'
import type { ReactNode } from 'react'
import { ConversationEmptyState } from '@/components/ai/conversation'
import { useStandingName } from './feature.tsx'
import { AgentMark, standingPlaceholder, useAgentTitle } from './marks.tsx'

function useStandingAgent(id: ConversationId | undefined) {
  const name = useStandingName(id)?.replace(/^@/, '')
  return { name, title: useAgentTitle(name ?? '').title }
}

export function useStandingPlaceholder({
  conversation,
  busy,
}: {
  conversation: ConversationId
  busy: boolean
}) {
  const { name, title } = useStandingAgent(conversation)
  return standingPlaceholder(name, title, busy)
}

export function useStandingEmpty({
  conversation,
  core,
}: {
  conversation: ConversationId
  core: ReactNode
}) {
  const { name, title } = useStandingAgent(conversation)
  if (!name || name === 'ultimate') return core
  return (
    <ConversationEmptyState className="min-h-[55vh]">
      <div className="flex flex-col items-center gap-2" data-ui="empty-state">
        <AgentMark name={name} size="lg" />
        <div className="mt-1 text-[15px] font-semibold text-foreground">{title}</div>
        <div className="font-mono text-[11px] text-muted-foreground/70">@{name}</div>
      </div>
    </ConversationEmptyState>
  )
}
