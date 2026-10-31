/**
 * Messages in the browser: every message between conversations and the user, which the sidebar, the message cards
 * and the sounds read, and the event of a question to the user. Browser-safe.
 * Stored identifiers keep the board prefix because history, tasks and events persist under them.
 */
import { actionRef, docRef } from '../../shared/extension-api.ts'
import { defineEvent } from '../../shared/events.ts'

/**
 * Another project's Ultimate: its project and machine, and `id`, that instance's id of the same message (the sender's
 * for an incoming one, the target's once an outgoing one is delivered).
 */
export type Remote = {
  project: string
  machine: string
  id?: number
  /** The sender's random key for the message: the target delivers it once, and only the target can reply to it. */
  key: string
}

/**
 * One question an agent asks the user with a message, as the `message` tool's `questions` argument declares it: the
 * answer card renders exactly this. `ref` is the number the message gives it ("2") and an option's `key` its letter
 * ("a"), so an answer can name them. An option's `preview` is Markdown shown beside it (a diff, a sketch); `scale`
 * bounds a numbered rating with its end labels; `placeholder` hints a typed answer.
 */
export type Question = {
  text: string
  kind: 'choice' | 'multi' | 'confirm' | 'text' | 'scale'
  ref?: string
  options?: {
    label: string
    detail?: string
    recommended?: boolean
    key?: string
    preview?: string
  }[]
  scale?: { min: number; max: number; low?: string; high?: string }
  placeholder?: string
}

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
  entry?: number
  answer?: number
  error?: string
  /** The tool call that sent it: `message`'s own id, or `<script>/<n>` for a nested codemode call. */
  call?: string
  /** Images forwarded with it: the sender's entry that holds them, attached to the recipient's input on delivery. */
  images?: { entry: number; count: number }
  /** A branch's final answer routed to its starter after it stopped with nothing under way: it awaits the starter. */
  report?: true
  /** The starter's final answer to a branch's report or reply, routed to that branch: the answer's entry. */
  routed?: number
  /** A branch's report answering routed answers only: the starter's answer to it stays local. */
  echo?: true
  /** The other project's Ultimate a `remote` side names. */
  remote?: Remote
  /** The questions a reply-expected message to the user asks, answered on its card. */
  questions?: Question[]
  /** A user answer or dismissal that @ultimate settled for the user, not their own click. */
  via?: Via
}
/** Where @ultimate settled a question for the user: its conversation, and the user's input it read the answer from. */
export type Via = { conversation: number; entry?: number }
export type MessagesData = { messages: Message[]; next: number }

/** Every message between conversations and the user, oldest first, on conversation 1. */
export const MessagesDoc = docRef<MessagesData>('board')

/**
 * `{ conversation, call }` → `{ entry }`: the response in `conversation`'s history that made tool call `call` (a
 * message's `call`), however old; no `entry` when the history has none.
 */
export const CallerAction = actionRef<{ conversation: number; call: string }, { entry?: number }>(
  'messages',
  'caller',
)

/**
 * `{ messageId, text, dismiss? }` → `{ id }`: @ultimate (or its side chat) settles the user's open question
 * `messageId` for them, from what they said in its chat: `text` is their answer, in their words or the picks read
 * from them, sent to the asker as the user's reply; with `dismiss`, `text` says why it no longer matters and the
 * asker gets a note. The answer records `via`, so the card shows @ultimate settled it. Refused from anyone else.
 */
export const SettleAction = actionRef<
  { messageId: number; text: string; dismiss?: boolean },
  { id: number }
>('messages', 'settle')

/**
 * Message `message` was posted from `from` to `to`; `reply` whether it waits for an answer, `steer` whether it
 * steers a busy recipient. Never its text. Emitted in the posting commit; answers are no posts.
 */
export const MessageSent = defineEvent<{
  message: number
  from: number | 'user' | 'remote'
  to: number | 'user' | 'remote'
  reply: boolean
  steer: boolean
}>('board.sent')
