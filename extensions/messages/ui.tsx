/**
 * Messages for other extensions' browser code: its document and sent event, what waits on the user's answer, the
 * pieces a message card is drawn from, and the point where an optional extension adds to a message (its answer card).
 */
import type { ConversationId } from '@earendil-works/pi-durable'
import type { ReactNode } from 'react'
import { ROOT, island, useDocOf } from '@/sdk'
import { StandingDoc } from '../subagents/ui.tsx'
import { BubbleHeader } from './bubble.solid.tsx'
import { Body as SolidBody } from './card-parts.solid.tsx'
import { MessageImages as SolidMessageImages } from './message-images.solid.tsx'
import { Address as SolidAddress } from './ui.solid.tsx'

export {
  conversationState,
  conversationWait,
  waitLabel,
  emptyMessages,
  isOpen,
  isOwed,
  openQuestion,
  stateTone,
  stateWord,
  waitingOnUser,
} from './data.ts'
export type { ConversationState } from './data.ts'
export { MessagesDoc, MessageSent } from './refs.ts'
/** Poll another project's reachability and optional progress every 15 seconds while it is named. */
export { useRemoteProgress } from './progress.tsx'
export { useStarters, useUnderway } from './started.tsx'
export { accentOf } from './accent.ts'
export const Address = island(SolidAddress, { inline: true })
export const Body = island(SolidBody)
export const MessageImages = island(SolidMessageImages)
const Header = island(BubbleHeader)

/** Voice live has a React prompt and answer; only the shared card header can mount as Solid here. */
export function Bubble({
  from,
  at,
  lead,
  children,
}: {
  from: ConversationId
  at?: number
  lead?: ReactNode
  children?: ReactNode
}) {
  const standing = useDocOf(ROOT, StandingDoc)
  return (
    <section
      className="group/bubble mt-2 w-full min-w-0"
      data-compact-bubble
      data-sender={standing?.ultimate === from ? 'ultimate' : undefined}
      data-ui="message-card"
    >
      <Header at={at} from={from} />
      <div className="[&>div]:px-0 [&>div]:pt-1.5 [&>div]:pb-0">{lead}</div>
      <div
        className="mt-3 overflow-hidden rounded-lg border border-border/70 bg-card/60 empty:hidden [&>:first-child]:border-t-0"
        data-ui="message-card-body"
      >
        {children}
      </div>
    </section>
  )
}
/**
 * Enabled timers with resolved conversation subscribers, provided by automations; `MessageExtras` adds to a message's
 * card and the Inbox above its answer (reel's chip), from every provider.
 */
export { MessageAnswers, MessageExtras, WaitTimers } from './points.ts'
