import type { ConversationId, JsonObject, Tx } from '@earendil-works/pi-durable'
import { defineTask } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'

type Delivery = {
  to: ConversationId
  type: 'input' | 'write'
  requestId: string
  kind: 'dream.requested' | 'dream.ready' | 'dream.prepared' | 'dream.chapter' | 'dream.carried'
  data?: JsonObject
  content: string
}

function preserveLegacySessionRequestId(input: unknown) {
  const { session, ...rest } = input as Omit<Delivery, 'requestId'> & { session: number }
  return {
    input: { ...rest, requestId: `${rest.kind}:${session}` },
    checkpoint: { phase: 'submit' as const },
  }
}
export const deliverTask = (host: Pick<ExtensionHost, 'harness'>) =>
  defineTask<Delivery, { phase: 'submit' }, null>({
    name: 'dream.deliver',
    version: 2,
    migrate: preserveLegacySessionRequestId,
    initial: () => ({ phase: 'submit' }),
    phases: {
      submit: async (task, runtime, ctx) => {
        const { to, type, requestId, kind, content } = task.input
        const data = task.input.data ?? {}
        const hostConversation = (await host.harness().conversation(to, ctx))!
        if (type === 'input')
          await hostConversation.submit(
            { type: 'input', requestId, content, entry: { kind, data }, whenBusy: 'followUp' },
            ctx,
          )
        else
          await hostConversation.submit(
            {
              type: 'write',
              requestId,
              entry: { kind, data, model: [{ role: 'user', content, timestamp: Date.now() }] },
            },
            ctx,
          )
        await runtime.commit(
          () => ({ status: 'terminal', outcome: { status: 'completed', result: null } }),
          ctx,
        )
      },
    },
    abort: (_task, runtime, ctx) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx),
  })

export const deliver = (
  host: Pick<ExtensionHost, 'harness'>,
  tx: Tx,
  to: ConversationId,
  delivery: Omit<Delivery, 'to'>,
) =>
  tx.createTask(
    deliverTask(host),
    { to, ...delivery },
    { conversationId: to, ownership: { kind: 'conversation' }, background: true },
  )
