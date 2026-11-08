/**
 * Where a message stands, read from its stored `state`. These are the only places that say which messages still wait
 * for an answer, which ones an answer is owed for, and which are open questions to the user. The Messages log
 * (extensions/messages) stores the messages. Pure, so server and browser code of any extension can share it.
 */
type Status = { reply: boolean; state: string; to: number | 'user' | 'remote' }

/** A reply-enabled message still waiting for its answer, whether delivered or still on its way. */
export const isOpen = (message: Status) =>
  message.reply && (message.state === 'sent' || message.state === 'delivered')

/**
 * An open message its recipient has received, so the recipient owes its answer. A message still queued is unread and
 * is not owed yet.
 */
export const isOwed = (message: Status) => message.reply && message.state === 'delivered'

/**
 * A question to the user that they have neither answered nor dismissed. A message to the user is delivered as soon as
 * it is sent.
 */
export const openQuestion = (message: Status) => message.to === 'user' && isOwed(message)
