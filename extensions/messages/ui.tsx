/**
 * Messages for other extensions' browser code: its document and sent event, what waits on the user's answer, the
 * pieces a message card is drawn from, and the point where an optional extension adds to a message (its answer card).
 */
export {
  conversationState,
  emptyMessages,
  isOpen,
  nextWaiting,
  stateTone,
  stateWord,
  waitingOnUser,
} from './data.tsx'
export type { ConversationState } from './data.tsx'
export { MessagesDoc, MessageSent } from './refs.ts'
export { accentOf } from './accent.tsx'
export { Address, Body, Bubble, useAccentOf } from './cards.tsx'
export { MessageAnswers } from './points.tsx'
