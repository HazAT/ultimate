import type { ConversationId, Tx } from '@earendil-works/pi-durable'
import { defineTask } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'

/** A goal card for @ultimate: `goal.started` as an input that wakes it, `goal.report` as a write. */
type Card = {
  to: ConversationId
  goal: number
  kind: 'goal.started' | 'goal.report'
  content: string
}

/** Created in the commit that changes the goal, so a crash cannot lose the card; the request id makes retries harmless. */
export const deliverTask = (host: Pick<ExtensionHost, 'harness'>) =>
  defineTask<Card, { phase: 'submit' }, null>({
    name: 'goal.deliver',
    version: 1,
    initial: () => ({ phase: 'submit' }),
    phases: {
      submit: async (task, runtime, ctx) => {
        const { to, goal, kind, content } = task.input
        const requestId = `${kind}:${goal}`
        const data = { goal }
        // The host handle, unlike the task runtime's, admits passive writes.
        const target = (await host.harness().conversation(to, ctx))!
        await target.submit(
          kind === 'goal.started'
            ? { type: 'input', requestId, content, entry: { kind, data }, whenBusy: 'followUp' }
            : {
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

export const deliver = (host: Pick<ExtensionHost, 'harness'>, tx: Tx, card: Card) =>
  tx.createTask(deliverTask(host), card, {
    conversationId: card.to,
    ownership: { kind: 'conversation' },
    background: true,
  })
