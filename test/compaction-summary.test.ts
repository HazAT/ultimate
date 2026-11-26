import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { createRegistry, Harness, MemoryStorage } from '@earendil-works/pi-durable'
import { admitCompaction } from '../lib/compaction.ts'
import { onCommit } from '../lib/commits.ts'
import { expect, it } from 'vitest'
import { context, prepareHarness } from '../server/harness.ts'
import { removeTemp, temp } from './helpers.ts'

it('rejects a second compaction while the first sleeps between retries', async () => {
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  const harness = await Harness.open(
    new MemoryStorage(),
    { models, registry: createRegistry(), now: () => 1_000_000, setTimer: () => () => {} },
    context,
  )
  try {
    const model = faux.getModel()
    const root = await harness.root(context, {
      agent: { model: { provider: model.provider, modelId: model.id } },
    })
    await harness.commit(async (tx) => {
      for (let n = 0; n < 8; n++)
        await tx.appendEntry(root.id, {
          kind: 'pi.user',
          model: [{ role: 'user', content: `Part ${n} ${'word '.repeat(4000)}`, timestamp: n }],
        })
    }, context)
    faux.setResponses([
      fauxAssistantMessage('', { stopReason: 'error', errorMessage: '529 overloaded' }),
    ])
    const taskId = await harness.commit((tx) => admitCompaction(tx, root.id), context)
    const sleeping = Promise.withResolvers<void>()
    const detach = onCommit(harness, ({ changes }) => {
      for (const change of changes)
        if (
          change.type === 'task' &&
          change.value.id === taskId &&
          change.value.state.status === 'sleeping'
        )
          sleeping.resolve()
    })
    try {
      harness.resume()
      await sleeping.promise
      await expect(harness.commit((tx) => admitCompaction(tx, root.id), context)).rejects.toThrow(
        `#${root.id} is already compacting`,
      )
    } finally {
      detach()
    }
  } finally {
    await harness.close(context)
  }
})

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
