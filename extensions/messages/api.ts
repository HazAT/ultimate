/**
 * Messages: messages between conversations and the user, delivered as inputs or notes. Other extensions send one-way
 * messages and answer the user's open questions here.
 */
import type {
  ConversationHandle,
  EntryId,
  InputSubmissionDraft,
  SubmissionId,
  TaskId,
  Tx,
  ConversationId,
} from '@earendil-works/pi-durable'
import type { Context } from '@earendil-works/chord/context'
import { defineDoc } from '@earendil-works/pi-durable'
import { defineApi } from '../../shared/extension-api.ts'
import type { Device } from '../../shared/events.ts'
import { JudgementsDoc, MessagesDoc } from './refs.ts'
import type { Judged, Question, Remote, Via } from './refs.ts'
import { checkpointEvery } from '../../shared/checkpoint.ts'

/** One message as the log stores it. */
export type Message = {
  id: number
  /** `remote`: another project's Ultimate, named by `remote`. */
  from: ConversationId | 'user' | 'remote'
  to: ConversationId | 'user' | 'remote'
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
  /** A branch's final answer routed to its starter after it stopped with nothing under way: it awaits the starter. */
  report?: true
  /** The starter's final answer to a branch's report or reply, routed to that branch: the answer's entry. */
  routed?: EntryId
  /** A branch's report answering routed answers only: the starter's answer to it stays local. */
  echo?: true
  /** The other project's Ultimate a `remote` side names. */
  remote?: Remote
  /** A reply to another Ultimate's request whose serving work goes on; that request stays open for the result. */
  interim?: true
  /** The owner already settled this request before its original answer was delivered. */
  ownerSettled?: true
  /** The questions a reply-expected message to the user asks, answered on its card. */
  questions?: Question[]
  /** A user answer or dismissal that @ultimate settled for the user, not their own click. */
  via?: Via
  /** How the judge weighed this branch's final answer before it went to the starter. */
  judged?: Judged
}
/**
 * The tool call ids of every reply-expected question a conversation asked the user, oldest first, on that
 * conversation. Unlike the message log it is never trimmed, so a call keeps marking where its question was asked.
 */
export const AskedCalls = defineDoc<{ calls: string[] }>({
  kind: 'board.asked-calls',
  checkpointWhen: checkpointEvery(100),
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ calls: [] }),
})
/** Every message between conversations and the user, on the root conversation. */
export const Messages = defineDoc<{ messages: Message[]; next: number }>({
  kind: MessagesDoc.kind,
  checkpointWhen: checkpointEvery(100),
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ messages: [], next: 1 }),
})

export type MessagesService = {
  /**
   * Reply `text` from the user to open message `messageId`, from browser `device`; returns the reply's message
   * id. Records a `user.input` event. With `call` (a tool call), a receipt commits with the reply, and a replay of
   * that call returns the same id even though the question is closed by then.
   */
  answer(
    messageId: number,
    text: string,
    ctx: Context,
    device?: Device,
    call?: { taskId: TaskId; callId: string },
  ): Promise<number>
  /**
   * The messages that wait on the user's answer, oldest first: each one's id, the conversation that asked, when, and its
   * question in one line (the line its card's header shows).
   */
  openQuestions(
    ctx: Context,
  ): Promise<{ message: number; conversation: ConversationId; at: number; text: string }[]>
  /**
   * Close open message `messageId` unanswered; its sender gets a one-way note. Returns the note's message id. `call`
   * works as for `answer`.
   */
  dismiss(
    messageId: number,
    ctx: Context,
    device?: Device,
    call?: { taskId: TaskId; callId: string },
  ): Promise<number>
  /** Send a one-way message from conversation `from` to `to` (`#id`, `@name` or `user`), once per `requestId`. */
  send(
    from: ConversationId,
    input: { to: string; text: string; reply: false },
    requestId: string,
    ctx: Context,
  ): Promise<number>
  /**
   * From the primary agent's conversation `from`, message another project's primary agent (on `machine`, else where it
   * runs): only that Ultimate receives it. With `reply`, its answer returns here as a reply. Returns this log's id of the
   * message and the target's id of the delivered one; throws a sentence naming the machine when it cannot be reached.
   * The post is a durable task created with the logged message: a crash before it settles posts again, once per key.
   */
  tell(
    from: ConversationId,
    input: { project: string; machine?: string; text: string; reply?: boolean },
    ctx: Context,
  ): Promise<{ message: number; delivered: number }>
  /**
   * In the creation transaction, let `automation` take over the requests related to @ultimate's current run.
   * Omit the id if the automation doesn't wake @ultimate. Return the branches that still expect the run's feedback.
   */
  owed(tx: Tx, to: ConversationId, automation?: string): Promise<{ branches?: ConversationId[] }>
  /** Admit an automation fire and track requests it owns in the same transaction. */
  submitFire(
    tx: Tx,
    to: ConversationHandle,
    input: InputSubmissionDraft,
    automation: { id: string; name: string },
  ): Promise<SubmissionId>
  /** In `tx`, fail any requests the automation still owns, naming the source and why it ended. */
  dropped(tx: Tx, automation: string, source: string, why: string): Promise<void>
}
export { MessageSent } from './refs.ts'
export type { Question, Serves } from './refs.ts'
/** The judge's verdict on each of a branch's final answers, by answer entry, on the branch; never trimmed. */
export const Judgements = defineDoc<{ answers: Record<number, Judged> }>({
  kind: JudgementsDoc.kind,
  checkpointWhen: checkpointEvery(100),
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ answers: {} }),
})

/** What the judge reads about a branch's final answer: excerpts of its previous answer, the inputs it answered and the answer. */
export type JudgeState = {
  branch_said_before: string
  inputs: { from: string; text: string }[]
  final_answer: string
}
export type JudgeService = {
  /**
   * The probability that the branch's final answer is something its starter must act on or know now, rather than
   * back-and-forth with the user. It throws an Error whose message is a short cause safe to show the user (never a
   * provider's response body) when it cannot judge. Messages reports on a throw or anything outside [0, 1].
   */
  report(state: JudgeState, signal: AbortSignal): Promise<number>
}
/** The extension point that judges whether a branch's answer wakes its starter; classify provides it. `want` it. */
export const Judge = defineApi<JudgeService>()('messages.judge')

/** Messages between conversations; core, so `need` it. */
export const MessagesApi = defineApi<MessagesService>()('messages')

export const tier = 'core'
