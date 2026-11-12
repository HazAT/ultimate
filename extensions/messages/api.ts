/**
 * Messages: messages between conversations and the user, delivered as inputs or notes. Other extensions send one-way
 * messages and answer the user's open questions here.
 */
import type { Context } from '@earendil-works/chord/context'
import { defineDoc } from '@earendil-works/pi-durable'
import type { EntryId } from '@earendil-works/pi-durable'
import { defineApi } from '../../shared/extension-api.ts'
import type { Device } from '../../shared/events.ts'
import { MessagesDoc } from './refs.ts'
import type { Question, Remote, Via } from './refs.ts'

/** One message as the log stores it. */
export type Message = {
  id: number
  /** `remote`: another project's Ultimate, named by `remote`. */
  from: number | 'user' | 'remote'
  to: number | 'user' | 'remote'
  text: string
  at: number
  reply: boolean
  re?: number
  state: 'sent' | 'delivered' | 'answered' | 'dismissed' | 'failed' | 'stopped'
  entry?: EntryId
  answer?: EntryId
  error?: string
  /** The tool call that sent it: `message`'s or `branch`'s own id, `<script>/<n>` for a nested codemode call. */
  call?: string
  /** Images forwarded with it: the sender's entry that holds them, attached to the recipient's input on delivery. */
  images?: { entry: EntryId; count: number }
  /** How many images the user attached to this answer: placed in the recipient's input, so `entry` holds them. */
  attached?: number
  /** A branch's final answer routed to its starter after it stopped with nothing under way: it awaits the starter. */
  report?: true
  /** A branch's reply to its starter: it awaits the starter's answer, routed down to it. */
  awaits?: true
  /** The starter's final answer to a branch's report or reply, routed to that branch: the answer's entry. */
  routed?: EntryId
  /** A branch's report answering routed answers only: the starter's answer to it stays local. */
  echo?: true
  /** The other project's Ultimate a `remote` side names. */
  remote?: Remote
  /** The questions a reply-expected message to the user asks, answered on its card. */
  questions?: Question[]
  /** A user answer or dismissal that @ultimate settled for the user, not their own click. */
  via?: Via
}
/** Every message between conversations and the user, on the root conversation. */
export const Messages = defineDoc<{ messages: Message[]; next: number }>({
  kind: MessagesDoc.kind,
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ messages: [], next: 1 }),
})

export type MessagesService = {
  /**
   * Reply `text` from the user to open message `messageId`, from browser `device`; returns the reply's message
   * id. Records a `user.input` event. `images` the user attached (at most 4 PNG, JPEG, WebP or GIF of 2 MiB each, as
   * base64; others are refused) go along in the asker's input.
   */
  answer(
    messageId: number,
    text: string,
    ctx: Context,
    device?: Device,
    images?: readonly { data: string; mimeType: string }[],
  ): Promise<number>
  /**
   * The messages that wait on the user's answer, oldest first: each one's id, the conversation that asked, when, and its
   * question in one line (the line its card's header shows).
   */
  openQuestions(
    ctx: Context,
  ): Promise<{ message: number; conversation: number; at: number; text: string }[]>
  /** Close open message `messageId` unanswered; its sender gets a one-way note. Returns the note's message id. */
  dismiss(messageId: number, ctx: Context, device?: Device): Promise<number>
  /** Send a one-way message from conversation `from` to `to` (`#id`, `@name` or `user`), once per `requestId`. */
  send(
    from: number,
    input: { to: string; text: string; reply: false },
    requestId: string,
    ctx: Context,
  ): Promise<number>
  /**
   * From the primary agent's conversation `from`, message another project's primary agent (on `machine`, else where it
   * runs): only that Ultimate receives it. With `reply`, its answer returns here as a reply. Returns this log's id of the
   * message and the target's id of the delivered one; throws a sentence naming the machine when it cannot be reached.
   */
  tell(
    from: number,
    input: { project: string; machine?: string; text: string; reply?: boolean },
    ctx: Context,
    signal?: AbortSignal,
  ): Promise<{ message: number; delivered: number }>
}
export { MessageSent } from './refs.ts'
export type { Question } from './refs.ts'
/** Messages between conversations; core, so `need` it. */
export const MessagesApi = defineApi<MessagesService>()('messages')

export const tier = 'core'
