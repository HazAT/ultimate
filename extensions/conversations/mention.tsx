import type { MouseEvent, ReactNode } from 'react'
import { parseMention } from '@/components/ai/mentions'
import { events, useConversationSummary, useUltimate } from '@/sdk'
import { ConversationRef } from './feature.tsx'

export function MentionLink({
  href,
  core,
}: {
  href: string
  children: ReactNode
  core: ReactNode
}) {
  const mention = parseMention(href)
  const { switchConversation, showSurface } = useUltimate()
  const conversation = useConversationSummary(mention?.conversation)
  if (!mention || !conversation) return core
  const { entry } = mention
  const open = (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    if (entry !== undefined) events.emit('messages:open', { conversation: conversation.id, entry })
    showSurface('agent')
    switchConversation(conversation.id)
  }
  return (
    <a
      className="inline-flex max-w-[min(100%,26rem)] min-w-0 items-center rounded-sm px-0.5 align-bottom font-mono text-[11.5px] leading-5 text-foreground no-underline transition-colors hover:bg-accent"
      data-conversation-mention={conversation.id}
      href={`?conversation=${conversation.id}`}
      onClick={open}
      title={`Open #${conversation.id}${entry !== undefined ? ` at entry ${entry}` : ''}${conversation.title ? `: ${conversation.title}` : ''}`}
    >
      <ConversationRef className="gap-1" id={conversation.id} />
      {entry !== undefined && <span className="shrink-0 text-muted-foreground/70">/{entry}</span>}
    </a>
  )
}
