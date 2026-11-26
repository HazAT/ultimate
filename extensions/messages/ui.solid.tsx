/**
 * Messages for other extensions' browser code: its document and sent event, what waits on the user's answer, the pieces
 * a message card is drawn from, and the points where an optional extension adds to a message (its answer card).
 */
export {
  conversationState,
  conversationWait,
  emptyMessages,
  isOpen,
  isOwed,
  openQuestion,
  stateTone,
  stateWord,
  waitLabel,
  waitingOnUser,
} from './data.ts'
export { MessagesDoc, MessageSent } from './refs.ts'
export { accentOf } from './accent.ts'
export type { ConversationState } from './data.ts'
export { useRemoteProgress } from './progress.solid.tsx'
export { useUnderway } from './started.solid.tsx'
export { Body } from './card-parts.solid.tsx'
/** The sender and timestamp header used by message-shaped cards. */
export { BubbleHeader } from './bubble.solid.tsx'
export { MessageImages } from './message-images.solid.tsx'
export { MessageAnswers, MessageExtras, WaitTimers } from './points.ts'
/** A stored assistant response whose speaker is external to Ultimate. */
export { ExternalSpeaker } from './points.ts'
/** An answer heading's mark, title and role, as stored answers show them; for a live answer that has no entry yet. */
export { SpeakerBadge } from './speaker.solid.tsx'

/** The standing name of the conversation, if it has one. */
export { useStandingName } from './standing-name.solid.tsx'

/** `you`, the remote project's address, `@name` for a standing agent or lander, else a conversation reference. */
export { Address } from './address.solid.tsx'
