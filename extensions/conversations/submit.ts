import type { ConversationId, SubmissionDraft, Tx } from '@earendil-works/pi-durable'
import { defineTask } from '@earendil-works/pi-durable'

export const SubmitAfter = defineTask<{ draft: SubmissionDraft }, { phase: 'submit' }, null>({
  name: 'conversations.submit',
  version: 1,
  initial: () => ({ phase: 'submit' }),
  phases: {
    submit: async (task, runtime, ctx) => {
      const to = (await runtime.conversation(runtime.conversationId, ctx))!
      await runtime.commit(async (tx) => {
        await to.submit(tx, task.input.draft)
        return { status: 'terminal', outcome: { status: 'completed', result: null } } as const
      }, ctx)
    },
  },
  abort: (_task, runtime, ctx) =>
    runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx),
})

export const submitAfter = async (tx: Tx, to: ConversationId, draft: SubmissionDraft) =>
  void (await tx.createTask(
    SubmitAfter,
    { draft },
    { conversationId: to, ownership: { kind: 'conversation' }, background: draft.type !== 'input' },
  ))
