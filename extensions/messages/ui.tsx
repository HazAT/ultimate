/**
 * Messages for other extensions' browser code: its document and sent event, what waits on the user's answer, the
 * pieces a message card is drawn from, and the point where an optional extension adds to a message (its answer card).
 */
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
} from './data.tsx'
export type { ConversationState } from './data.tsx'
export { MessagesDoc, MessageSent } from './refs.ts'
/** Poll another project's reachability and optional progress every 15 seconds while it is named. */
export { useRemoteProgress } from './progress.tsx'
export { useStarters, useUnderway } from './started.tsx'
export { accentOf } from './accent.tsx'
export { Address, Body, Bubble, MessageImages, useAccentOf } from './cards.tsx'
/**
 * Enabled timers with resolved conversation subscribers, provided by automations; `MessageExtras` adds to a message's
 * card and the Inbox above its answer (reel's chip), from every provider.
 */
export { MessageAnswers, MessageExtras, WaitTimers } from './points.tsx'
