import type { ReactNode } from 'react'
import { ConversationEmptyState } from '@/components/ai/conversation'
import { useStandingName } from './feature.tsx'
import { AgentMark, standingPlaceholder, useAgentTitle } from './marks.tsx'

/** Conversation `id`'s standing agent as definitions and marks know it (without the `@`), and its display title. */
function useStandingAgent(id: number) {
  const name = useStandingName(id)?.replace(/^@/, '')
  return { name, title: useAgentTitle(name ?? '').title }
}

/** What an idle standing agent's composer says: "Message <title>…"; the core's text everywhere else. */
export function useStandingPlaceholder({
  conversation,
  busy,
}: {
  conversation: number
  busy: boolean
}) {
  const { name, title } = useStandingAgent(conversation)
  return standingPlaceholder(name, title, busy)
}

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
