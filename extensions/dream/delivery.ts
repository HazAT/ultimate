import { defineTask } from '@earendil-works/pi-durable'
import type { ConversationId, JsonObject, Tx } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'

/**
 * One entry for @ultimate: an `input` that wakes it, or a `write` the model reads at its next step. `requestId` makes
 * a retried delivery harmless.
 */
type Delivery = {
  to: number
  type: 'input' | 'write'
  requestId: string
  kind: 'dream.requested' | 'dream.ready' | 'dream.prepared' | 'dream.chapter'
  data?: JsonObject
  content: string
}

/** Deliveries are created with their source state; submission request ids make retries harmless. */
export const deliverTask = (host: Pick<ExtensionHost, 'harness'>) =>
  defineTask<Delivery, { phase: 'submit' }, null>({
    name: 'dream.deliver',
    // Version 1 keyed its request by `session`: a delivery still pending from before keeps its request id.
    version: 2,
    migrate: (input) => {
      const { session, ...rest } = input as Omit<Delivery, 'requestId'> & { session: number }
      return {
        input: { ...rest, requestId: `${rest.kind}:${session}` },
        checkpoint: { phase: 'submit' as const },
      }
    },
    initial: () => ({ phase: 'submit' }),
    phases: {
      submit: async (task, runtime, ctx) => {
        const { to, type, requestId, kind, content } = task.input
        const data = task.input.data ?? {}
        // The host handle, unlike the task runtime's, admits passive writes.
        const target = (await host.harness().conversation(to as ConversationId, ctx))!
        if (type === 'input')
          await target.submit(
            { type: 'input', requestId, content, entry: { kind, data }, whenBusy: 'followUp' },
            ctx,
          )
        else
          await target.submit(
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
  to: number,
  delivery: Omit<Delivery, 'to'>,
) =>
  tx.createTask(
    deliverTask(host),
    { to, ...delivery },
    { conversationId: to as ConversationId, ownership: { kind: 'conversation' }, background: true },
  )
