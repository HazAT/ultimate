/** `send()`: validating, admitting and logging a message, and starting its delivery. */
import type { Context } from '@earendil-works/chord'
import { defineDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId, TaskId } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { Standing } from '../subagents/api.ts'
import { Messages, MessageSent } from './api.ts'
import type { Question } from './api.ts'
import { checkQuestions, openQuestion } from './questions.ts'
import { UserInputEvent } from '../../shared/events.ts'
import type { Device } from '../../shared/events.ts'
import { resolveImages } from './images.ts'
import type { ImagesRef } from './images.ts'
import { append } from './log.ts'
import { parentOf, resolve, senderName, starterOf } from './addresses.ts'
import { delivery } from './delivery.ts'

// The receipt commits with the message, closing the gap before api.memo records its id.
const Sent = defineDoc<{ ids: Record<string, number> }>({
  kind: 'board.sent-calls',
  checkpointWhen: () => false,
  version: 1,
  scope: 'task',
  initial: () => ({ ids: {} }),
})
// Pipeline requests outlive their calling task, so their receipts belong to the sender conversation.
const Requests = defineDoc<{ ids: Record<string, number> }>({
  kind: 'board.requests',
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ ids: {} }),
})
export async function send(
  host: ExtensionHost,
  from: number | 'user',
  input: {
    to: string
    text: string
    reply?: boolean
    steer?: boolean
    re?: number
    images?: ImagesRef
    /** Images belong to the caller, even when another conversation is credited as sender. */
    imagesFrom?: ConversationId
    /** The user's reply `re` dismisses that question instead of answering it. */
    dismiss?: boolean
    /** With `to: 'user'`, the decisions the message asks, as its answer card shows them. */
    questions?: Question[]
  },
  ctx: Context,
  options: {
    /** The sending tool call: its task-scoped receipt deduplicates admission. */
    taskId?: TaskId
    callId?: string
    /** A pipeline's request id, deduplicated in the sender conversation. */
    requestId?: string
    /** The user's answer or dismissal of open message `answerId`. */
    answerId?: number
    /** Place it as a note, which starts no run; by default one-way messages to the sender's starter are notes. */
    note?: boolean
    device?: Device
    /** A branch's final answer routed as its report: the branch shows as awaiting its starter. */
    report?: boolean
  } = {},
) {
  const { taskId, callId, requestId, answerId, device } = options
  if (requestId !== undefined && from !== 'user') {
    const sent = await host.harness().snapshot(Requests, from as ConversationId, ctx)
    if (sent?.ids[requestId] !== undefined) return sent.ids[requestId]
  }
  if (taskId !== undefined) {
    const sent = await host.harness().snapshot(Sent, taskId, ctx)
    if (callId !== undefined && sent?.ids[callId] !== undefined) return sent.ids[callId]
  }
  const standing = await host.harness().snapshot(Standing, ROOT_CONVERSATION_ID, ctx)
  const primaryId = standing?.ultimate
  // The primary agent's messages to a busy conversation almost always steer it: new scope, a decision, a stop.
  const steer = input.steer ?? (from !== 'user' && from === primaryId)
  if (input.to === 'user') {
    if (from !== primaryId)
      throw new Error(
        'Only @ultimate messages the user; send this to @ultimate (reply: false) and it relays it.',
      )
  }
  if (!input.text.trim()) throw new Error('Message text must not be empty')
  if (input.questions !== undefined && (input.to !== 'user' || input.reply === false))
    throw new Error('questions go only with a reply-expected message to the user')
  const questions = input.questions === undefined ? undefined : checkQuestions(input.questions)
  // Checked before resolving, which may create a standing agent's conversation.
  const parent = from === 'user' ? undefined : await parentOf(host, from, ctx)
  const starter = parent ?? (await starterOf(host, from, ctx))
  if (parent !== undefined && input.to.replace(/^#/, '') !== String(parent))
    throw new Error(
      `Subagents report to the conversation that started them: message only #${parent}. Your final answer reaches it anyway.`,
    )
  const to = await resolve(host, input.to, from, ctx)
  const fromLabel = await senderName(host, from, ctx)
  const toLabel = await senderName(host, to, ctx)
  return host.harness().commit(async (tx) => {
    const receipt = taskId === undefined ? undefined : await tx.doc(Sent, taskId)
    const requests =
      requestId === undefined || from === 'user'
        ? undefined
        : await tx.doc(Requests, from as ConversationId)
    if (requestId !== undefined && requests?.ids[requestId] !== undefined)
      return requests.ids[requestId]
    if (callId !== undefined && receipt?.ids[callId] !== undefined) return receipt.ids[callId]
    if (answerId !== undefined) {
      const original = (await tx.doc(Messages, ROOT_CONVERSATION_ID)).messages.find(
        (m) => m.id === answerId,
      )
      if (!original || !openQuestion(original))
        throw new Error('These questions are no longer open')
    }
    if (input.images !== undefined && from === 'user')
      throw new Error('your images go along with what you submit, not with a message')
    const images =
      input.images === undefined
        ? undefined
        : await resolveImages(tx, input.imagesFrom ?? (from as ConversationId), input.images)
    // Only a Reply answers a question to the user, and only the one it replies to; a dismissal closes it unanswered.
    if (from === 'user' && input.re !== undefined)
      for (const m of (await tx.doc(Messages, ROOT_CONVERSATION_ID)).messages)
        if (openQuestion(m) && m.id === input.re) m.state = input.dismiss ? 'dismissed' : 'answered'
    let re = input.re
    let also: number[] | undefined
    if (from !== 'user' && input.reply !== false) {
      const log = await tx.doc(Messages, ROOT_CONVERSATION_ID)
      // Only a message the agent has read is owed; one still queued is unread and gets its own turn. It answers every
      // owed one: their deliveries, seeing them answered, send no reply of their own.
      const owed = log.messages.filter(
        (m) => m.to === from && m.from === to && m.reply && m.state === 'delivered',
      )
      for (const m of owed) m.state = 'answered'
      const [pending] = owed
      if (owed.length > 1) also = owed.slice(1).map((m) => m.id)
      // A message to the user who is owed an answer is that answer, with its questions and images.
      if (pending && to === 'user') re = pending.id
      // An agent messaging a sender whose message it has read and owes an answer is answering: this becomes the reply,
      // and that message's delivery, seeing it answered, keeps the final answer local.
      else if (pending) {
        const response = await append(tx, {
          from,
          to,
          text: input.text,
          reply: false,
          re: pending.id,
          ...(also ? { also } : {}),
          state: 'sent',
          ...(callId === undefined ? {} : { call: callId }),
          ...(images ? { images } : {}),
        })
        await tx.createTask(
          delivery(host),
          {
            message: pending,
            steer: false,
            note: false,
            fromLabel: toLabel,
            toLabel: fromLabel,
            reply: { message: response, failed: false },
          },
          {
            conversationId: ROOT_CONVERSATION_ID,
            ownership: { kind: 'conversation' },
            background: true,
          },
        )
        if (receipt && callId !== undefined) receipt.ids[callId] = response.id
        if (requests && requestId !== undefined) requests.ids[requestId] = response.id
        return response.id
      }
    }
    const message = await append(tx, {
      from,
      to,
      text: input.text,
      reply: input.reply ?? true,
      state: to === 'user' ? 'delivered' : 'sent',
      ...(re === undefined ? {} : { re }),
      ...(also ? { also } : {}),
      ...(callId === undefined ? {} : { call: callId }),
      ...(images ? { images } : {}),
      ...(questions ? { questions } : {}),
      ...(options.report ? { report: true as const } : {}),
    })
    await host.emit(tx, MessageSent, {
      message: message.id,
      from,
      to,
      reply: message.reply,
      steer,
    })
    // The user's answer or dismissal is their input to the asker; the message's `entry` names it once delivered.
    if (from === 'user' && answerId !== undefined && typeof to === 'number')
      await host.emit(tx, UserInputEvent, {
        conversation: to,
        kind: input.dismiss ? 'dismiss' : 'answer',
        message: message.id,
        length: input.dismiss ? 0 : input.text.length,
        ...device,
      })
    if (to !== 'user')
      await tx.createTask(
        delivery(host),
        {
          message,
          steer,
          note: options.note ?? (starter === to && input.reply === false),
          fromLabel,
          toLabel,
        },
        {
          conversationId: ROOT_CONVERSATION_ID,
          ownership: { kind: 'conversation' },
          background: true,
        },
      )
    if (receipt && callId !== undefined) receipt.ids[callId] = message.id
    if (requests && requestId !== undefined) requests.ids[requestId] = message.id
    return message.id
  }, ctx)
}
