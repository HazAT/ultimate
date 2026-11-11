import { defineExtension, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { BACKGROUND_CONTEXT as context, withAbortSignal } from '@earendil-works/chord/context'
import type { ExtensionHost } from '../../server/extensions.ts'
import { Messages, MessagesApi } from '../messages/api.ts'
import type { Question } from '../messages/api.ts'
import { implementAction } from '../../lib/actions.ts'
import { openQuestion as open } from '../../lib/message-state.ts'
import { AnswerAction, DismissAction } from './refs.ts'
import type { Answer } from './refs.ts'

const NOT_OPEN = 'These questions are no longer open'

const filled = (text: unknown) => typeof text === 'string' && !!text.trim()
function validAnswers(value: unknown): value is Answer[] {
  return (
    Array.isArray(value) &&
    value.every(
      (a: { question?: unknown; answer?: unknown } | null) =>
        a &&
        typeof a.question === 'string' &&
        (Array.isArray(a.answer)
          ? a.answer.length > 0 && a.answer.every(filled)
          : filled(a.answer)),
    )
  )
}
function checkAnswers(answers: { question: string }[], questions: Question[]) {
  if (
    new Set(answers.map((a) => a.question)).size !== answers.length ||
    answers.some((a) => !questions.some((q) => q.text === a.question))
  )
    throw new Error('Unknown question')
}
/** The keys of the chosen options, in option order: "a", "a,c"; none when an answer names no option. */
function keysOf(question: Question, labels: string[]) {
  const keys = (question.options ?? []).flatMap((o) =>
    o.key && labels.includes(o.label) ? [o.key] : [],
  )
  return keys.length === labels.length ? keys.join(',') : ''
}
/**
 * The reply naming each answer by the message's own numbering: `1a. Topic: label` for an option (`2a,c.` for
 * several), `3: text` for typed text or a rating, `Topic: answer` when the message numbered nothing; a note from the
 * card's field follows the answers.
 */
export function answerText(answers: Answer[], questions: Question[], note?: string) {
  const lines = answers.map(({ question, answer: given }) => {
    const q = questions.find((candidate) => candidate.text === question)!
    const labels = [given].flat()
    const keys = keysOf(q, labels)
    const answer = labels.join(', ')
    if (!q.ref) return `${q.text}: ${answer}`
    return keys ? `${q.ref}${keys}. ${q.text}: ${answer}` : `${q.ref}: ${answer}`
  })
  if (note?.trim()) lines.push(answers.length ? `Note: ${note.trim()}` : note.trim())
  return lines.join('\n\n')
}

export const userActions = ['answer', 'dismiss']
export const actions = {
  /** Answer an open message from its questions, with a note, or as free text: a user reply to its sender. */
  answer: implementAction(AnswerAction, async (args, { host, signal, device }) => {
    const data = args as {
      messageId: number
      answers?: Answer[]
      note?: unknown
      text?: unknown
    }
    const text = typeof data?.text === 'string' ? data.text.trim() : undefined
    const note = typeof data?.note === 'string' ? data.note.trim() : undefined
    const answers = data?.answers ?? []
    if (
      !data ||
      !Number.isSafeInteger(data.messageId) ||
      (text === undefined
        ? !validAnswers(answers) || (!answers.length && !note)
        : !text || data.answers !== undefined || note)
    )
      throw new Error('Invalid answers')
    const reply = await host.harness().commit(async (tx) => {
      const log = await tx.doc(Messages, ROOT_CONVERSATION_ID)
      const message = log.messages.find((m) => m.id === data.messageId)
      if (!message || !open(message)) throw new Error(NOT_OPEN)
      if (text !== undefined) return text
      checkAnswers(answers, message.questions ?? [])
      return answerText(answers, message.questions ?? [], note)
    }, context)
    return {
      id: await host
        .need(MessagesApi)
        .answer(data.messageId, reply, withAbortSignal(signal, context), device),
    }
  }),
  /** Close an open message to the user unanswered; its sender gets a one-way note. */
  dismiss: implementAction(DismissAction, async (args, { host, signal, device }) => {
    const data = args as { messageId: number }
    if (!data || !Number.isSafeInteger(data.messageId)) throw new Error('Invalid message')
    return {
      id: await host
        .need(MessagesApi)
        .dismiss(data.messageId, withAbortSignal(signal, context), device),
    }
  }),
}

export default function questionsExtension(host: ExtensionHost) {
  // Core, always on; resolved where it is called, declared here so the catalogue lists it.
  host.need(MessagesApi)
  return defineExtension({ name: 'questions' })
}
