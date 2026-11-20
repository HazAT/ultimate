import type { ConversationId, EntryId, TaskId } from '@earendil-works/pi-durable'
import type { Context } from '@earendil-works/chord/context'
import { defineDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { Standing } from '../subagents/api.ts'
import { Messages, MessageSent } from './api.ts'
import type { Message, Question } from './api.ts'
import type { Via } from './refs.ts'
import { checkQuestions, gist, openQuestion } from './questions.ts'
import { isOwed } from '../../lib/message-state.ts'
import { UserInputEvent } from '../../shared/events.ts'
import type { Device } from '../../shared/events.ts'
import { resolveImages } from './images.ts'
import type { ImagesRef } from './images.ts'
import { append } from './log.ts'
import { parentOf, resolveRecipient, senderName, serve, starterOf } from './addresses.ts'
import { delivery } from './delivery.ts'
import { notice } from './notice.ts'

const AtomicallyCommittedCallReceipts = defineDoc<{ ids: Record<string, number> }>({
  kind: 'board.sent-calls',
  checkpointWhen: () => false,
  version: 1,
  scope: 'task',
  initial: () => ({ ids: {} }),
})

const ConversationRequestReceipts = defineDoc<{ ids: Record<string, number> }>({
  kind: 'board.requests',
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ ids: {} }),
})

export async function receiptOf(
  host: ExtensionHost,
  call: { taskId: TaskId; callId: string },
  ctx: Context,
) {
  return (await host.harness().snapshot(AtomicallyCommittedCallReceipts, call.taskId, ctx))?.ids[
    call.callId
  ]
}

const answerSummary = (text: string) => {
  const lines = text.split('\n').filter((line) => line.trim())
  const picks = lines.flatMap((line) => /^(\d+[a-z,]*)[.:]/.exec(line)?.[1] ?? [])
  return picks.length ? picks.join(' ') : (lines[0] ?? '')
}

export async function send(
  host: ExtensionHost,
  from: ConversationId | 'user',
  input: {
    to: string
    text: string
    reply?: boolean
    steer?: boolean
    re?: number
    images?: ImagesRef
    imagesFrom?: ConversationId
    dismiss?: boolean
    questions?: Question[]
  },
  ctx: Context,
  options: {
    taskId?: TaskId
    callId?: string
    requestId?: string
    answerId?: number
    note?: boolean
    device?: Device
    via?: Via
    report?: boolean
    routed?: EntryId
    echo?: boolean
    serveBranch?: true
  } = {},
) {
  const { taskId, callId, requestId, answerId, device, via } = options
  if (requestId !== undefined && from !== 'user') {
    const sent = await host.harness().snapshot(ConversationRequestReceipts, from, ctx)
    if (sent?.ids[requestId] !== undefined) return sent.ids[requestId]
  }
  if (taskId !== undefined) {
    const sent = await host.harness().snapshot(AtomicallyCommittedCallReceipts, taskId, ctx)
    if (callId !== undefined && sent?.ids[callId] !== undefined) return sent.ids[callId]
  }
  const standing = await host.harness().snapshot(Standing, ROOT_CONVERSATION_ID, ctx)
  const primaryId = standing?.ultimate

  const primaryMessagesSteerByDefault = from !== 'user' && from === primaryId
  const steer = input.steer ?? primaryMessagesSteerByDefault

  const parent = from === 'user' ? undefined : await parentOf(host, from, ctx)
  const starter = parent ?? (await starterOf(host, from, ctx))
  if (input.to === 'user' && parent !== undefined)
    throw new Error(
      `A subagent answers the conversation that started it: give your final answer, or message #${parent}.`,
    )
  if (!input.text.trim()) throw new Error('Message text must not be empty')
  if (input.questions !== undefined && (input.to !== 'user' || input.reply === false))
    throw new Error('questions go only with a reply-expected message to the user')
  const questions = input.questions === undefined ? undefined : checkQuestions(input.questions)
  if (parent !== undefined && input.to.replace(/^#/, '') !== String(parent))
    throw new Error(
      `Subagents report to the conversation that started them: message only #${parent}. Your final answer reaches it anyway.`,
    )
  const to = await resolveRecipient(host, input.to, from, ctx)
  const fromLabel = via
    ? `user (settled for them by @ultimate, from what they said in its chat)`
    : await senderName(host, from, ctx)
  const toLabel = await senderName(host, to, ctx)
  return host.harness().commit(async (tx) => {
    const receipt =
      taskId === undefined ? undefined : await tx.doc(AtomicallyCommittedCallReceipts, taskId)
    const requests =
      requestId === undefined || from === 'user'
        ? undefined
        : await tx.doc(ConversationRequestReceipts, from)
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
    let images: Message['images']
    if (input.images !== undefined) {
      if (from === 'user')
        throw new Error('your images go along with what you submit, not with a message')
      images = await resolveImages(tx, input.imagesFrom ?? from, input.images)
    }

    if (from === 'user' && input.re !== undefined)
      for (const m of (await tx.doc(Messages, ROOT_CONVERSATION_ID)).messages)
        if (openQuestion(m) && m.id === input.re) m.state = input.dismiss ? 'dismissed' : 'answered'
    let re = input.re
    if (from !== 'user' && input.reply !== false) {
      const log = await tx.doc(Messages, ROOT_CONVERSATION_ID)

      const readMessageOwedToRecipient = log.messages.find(
        (m) => m.to === from && m.from === to && isOwed(m),
      )

      if (readMessageOwedToRecipient && to === 'user') {
        readMessageOwedToRecipient.state = 'answered'
        re = readMessageOwedToRecipient.id
      } else if (readMessageOwedToRecipient) {
        readMessageOwedToRecipient.state = 'answered'
        const response = await append(tx, {
          from,
          to,
          text: input.text,
          reply: false,
          re: readMessageOwedToRecipient.id,
          state: 'sent',
          ...(callId === undefined ? {} : { call: callId }),
          ...(images ? { images } : {}),
        })
        await tx.createTask(
          delivery(host),
          {
            message: readMessageOwedToRecipient,
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
    if (options.serveBranch && typeof from === 'number' && typeof to === 'number')
      await serve(host, tx, from, { kind: 'branch', id: to })
    const message = await append(tx, {
      from,
      to,
      text: input.text,
      reply: input.reply ?? true,
      state: to === 'user' ? 'delivered' : 'sent',
      ...(re === undefined ? {} : { re }),
      ...(callId === undefined ? {} : { call: callId }),
      ...(images ? { images } : {}),
      ...(questions ? { questions } : {}),
      ...(options.report ? { report: true as const } : {}),
      ...(options.routed !== undefined ? { routed: options.routed } : {}),
      ...(options.echo ? { echo: true as const } : {}),
      ...(via ? { via } : {}),
    })
    await host.emit(tx, MessageSent, {
      message: message.id,
      from,
      to,
      reply: message.reply,
      steer,
    })
    if (primaryId !== undefined) {
      const asked = to === 'user' && message.reply && from !== primaryId && typeof from === 'number'
      const answered =
        from === 'user' && answerId !== undefined && typeof to === 'number' && to !== primaryId
      const notification = asked
        ? {
            kind: 'board.asked' as const,
            data: {
              message: message.id,
              from,
              ...(callId === undefined ? {} : { call: callId }),
              summary: questions?.length
                ? `asks you ${questions.length} question${questions.length === 1 ? '' : 's'} · ${questions[0].text}`
                : `asks you · ${input.text.split('\n')[0]}`,
            },
            content: `#${from} asked the user (message ${message.id}): ${gist(message)}. The user answers there; their answer reaches you as a note.`,
          }
        : answered
          ? {
              kind: 'board.answered' as const,
              data: {
                message: answerId,
                from: to,
                ...(via ? { via } : {}),
                ...(input.dismiss
                  ? { dismissed: true }
                  : {
                      summary: answerSummary(input.text),
                    }),
              },
              content: via
                ? `You settled #${to}'s questions (message ${answerId}) for the user${input.dismiss ? ', closed without an answer' : ''}.`
                : input.dismiss
                  ? `The user dismissed #${to}'s questions (message ${answerId}).`
                  : `The user answered #${to}'s questions (message ${answerId}):\n${input.text}`,
            }
          : undefined
      if (notification)
        await tx.createTask(
          notice(host),
          { to: primaryId, ...notification },
          {
            conversationId: primaryId,
            ownership: { kind: 'conversation' },
            background: true,
          },
        )
    }

    const userAnswerNotAlreadyCountedInChat =
      from === 'user' && answerId !== undefined && typeof to === 'number' && !via
    if (userAnswerNotAlreadyCountedInChat)
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
