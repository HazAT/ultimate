import type { ReactNode } from 'react'
import { ConversationEmptyState } from '@/components/ai/conversation'
import { useStandingName } from './feature.tsx'
import { AgentMark, useAgentTitle } from './marks.tsx'

/**
 * A standing agent's transcript before its first message: its mark, title and `@name`, in the dock, the full view and
 * on a phone alike, rather than the core's card of repo, model and host. @ultimate and other conversations keep `core`.
 */
export function useStandingEmpty({
  conversation,
  core,
}: {
  conversation: number
  core: ReactNode
}) {
  // The standing name is the `@name` address; definitions and marks know it without the `@`.
  const name = useStandingName(conversation)?.replace(/^@/, '')
  const { title } = useAgentTitle(name ?? '')
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
