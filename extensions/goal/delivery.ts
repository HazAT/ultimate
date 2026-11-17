import type { ConversationId, Tx } from '@earendil-works/pi-durable'
import { defineTask } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'

type Card = {
  to: ConversationId
  goal: number
  kind: 'goal.started' | 'goal.report'
  content: string
}

export const deliverTask = (host: Pick<ExtensionHost, 'harness'>) =>
  defineTask<Card, { phase: 'submit' }, null>({
    name: 'goal.deliver',
    version: 1,
    initial: () => ({ phase: 'submit' }),
    phases: {
      submit: async (task, runtime, ctx) => {
        const { to, goal, kind, content } = task.input
        const cardOncePerGoal = `${kind}:${goal}`
        const data = { goal }
        const passiveWriteTarget = (await host.harness().conversation(to, ctx))!
        await passiveWriteTarget.submit(
          kind === 'goal.started'
            ? {
                type: 'input',
                requestId: cardOncePerGoal,
                content,
                entry: { kind, data },
                whenBusy: 'followUp',
              }
            : {
                type: 'write',
                requestId: cardOncePerGoal,
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
