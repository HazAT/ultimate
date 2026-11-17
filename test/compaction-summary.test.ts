import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { expect, it } from 'vitest'
import { context, prepareHarness } from '../server/harness.ts'
import { removeTemp, temp } from './helpers.ts'

// The pi-durable patch: Pi capped summaries at 0.8 × reserveTokens (13,107 by default), which reasoning used up.
it('a compaction summary may use the model output limit', async () => {
  const home = await temp()
  const faux = fauxProvider()
  const opened = await (
    await prepareHarness({ ultimateRoot: home, userHome: home, home, faux })
  ).open(false)
  try {
    const { harness } = opened
    const model = faux.getModel()
    const { id } = await harness.commit(
      (tx) => tx.createConversation({ ownership: { kind: 'ownerless' } }),
      context,
    )
    const conversation = (await harness.conversation(id, context))!
    await conversation.configure(
      { model: { provider: model.provider, modelId: model.id } },
      context,
    )
    // Enough history for Pi to summarize rather than skip a short context.
    await harness.commit(async (tx) => {
      for (let n = 0; n < 8; n++)
        await tx.appendEntry(id, {
          kind: 'pi.user',
          model: [{ role: 'user', content: `Part ${n} ${'word '.repeat(4000)}`, timestamp: n }],
        })
    }, context)
    let maxTokens: number | undefined
    faux.setResponses([
      (_context, options) => {
        maxTokens = options?.maxTokens
        return fauxAssistantMessage('Summary')
      },
    ])
    await harness.waitForTask(await conversation.compact(undefined, context), context)
    expect(maxTokens).toBe(model.maxTokens)
  } finally {
    await opened.close()
    await removeTemp(home)
  }
})
