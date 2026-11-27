import { defineExtension, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { BACKGROUND_CONTEXT as context, withAbortSignal } from '@earendil-works/chord/context'
import type { ExtensionHost } from '../../server/extensions.ts'
import { Messages, MessagesApi } from '../messages/api.ts'
import { implementAction } from '../../lib/actions.ts'
import { openQuestion as open } from '../../lib/message-state.shared.ts'
import { checkReply, replyText } from '../../lib/question-answers.ts'
import { AnswerAction, DismissAction } from './refs.ts'
import type { Reply } from '../../lib/question-answers.ts'

export { answerText } from '../../lib/question-answers.ts'

const NOT_OPEN = 'These questions are no longer open'

export const userActions = ['answer', 'dismiss']
export const actions = {
  answer: implementAction(AnswerAction, async (args, { host, signal, device }) => {
    const data = args as Reply & { messageId: number }
    if (!data || !Number.isSafeInteger(data.messageId)) throw new Error('Invalid answers')
    checkReply(data)
    const reply = await host.harness().commit(async (tx) => {
      const log = await tx.doc(Messages, ROOT_CONVERSATION_ID)
      const message = log.messages.find((m) => m.id === data.messageId)
      if (!message || !open(message)) throw new Error(NOT_OPEN)
      return replyText(data, message.questions ?? [])
    }, context)
    return {
      id: await host
        .need(MessagesApi)
        .answer(data.messageId, reply, withAbortSignal(signal, context), device),
    }
  }),
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
  host.need(MessagesApi)
  return defineExtension({ name: 'questions' })
}
