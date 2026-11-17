import type { ConversationId, EntryId } from '@earendil-works/pi-durable'
import { defineTask } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'

export const notice = (host: Pick<ExtensionHost, 'harness'>) =>
  defineTask<
    {
      to: ConversationId
      kind: 'board.asked' | 'board.answered'
      data: {
        message: number
        from: ConversationId
        call?: string
        summary?: string
        dismissed?: boolean
        via?: { conversation: ConversationId; entry?: EntryId }
      }
      content: string
    },
    { phase: 'submit' },
    null
  >({
    name: 'board.notice',
    version: 1,
    initial: () => ({ phase: 'submit' }),
    phases: {
      submit: async (task, runtime, ctx) => {
        const { to, kind, data, content } = task.input
        const target = (await host.harness().conversation(to, ctx))!
        await target.submit(
          {
            type: 'write',
            requestId: `${kind}:${data.message}`,
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
