import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { createRegistry, Harness, MemoryStorage } from '@earendil-works/pi-durable'
import { expect, it } from 'vitest'
import { compactionEvents } from '../compactions.ts'
import { until } from '../../../test/helpers.ts'

// A background compaction that failed was reported nowhere: the agent ran on until its blocking one failed the run.
it('a failed compaction its conversation owns raises a notice', async () => {
  const models = createModels()
  const faux = fauxProvider()
  models.setProvider(faux.provider)
  const harness = await Harness.open(
    new MemoryStorage(),
    { models, registry: createRegistry() },
    context,
  )
  const model = faux.getModel()
  const root = await harness.root(context, {
    agent: { model: { provider: model.provider, modelId: model.id } },
  })
  const notices: string[] = []
  const resources = new Map<string, unknown>()
  let open!: () => Promise<void>
  let close!: () => Promise<void>
  compactionEvents({
    harness: () => harness,
    emit: async () => {},
    onOpen: (callback: () => Promise<void>) => {
      open = callback
    },
    onClose: (callback: () => Promise<void>) => {
      close = callback
    },
    notice: (message: string) => notices.push(message),
    resource: (key: string, create: () => unknown) => {
      if (!resources.has(key)) resources.set(key, create())
      return resources.get(key)
    },
  } as unknown as Parameters<typeof compactionEvents>[0])
  await open()
  try {
    // Enough history for Pi to summarize rather than skip a short context.
    await harness.commit(async (tx) => {
      for (let n = 0; n < 8; n++)
        await tx.appendEntry(root.id, {
          kind: 'pi.user',
          model: [{ role: 'user', content: `Part ${n} ${'word '.repeat(4000)}`, timestamp: n }],
        })
    }, context)
    faux.setResponses([fauxAssistantMessage('Partial summary', { stopReason: 'length' })])
    await harness.waitForTask(await root.compact(undefined, context), context)
    await until(() => notices.length > 0)
    expect(notices).toEqual([
      `Compaction of #${root.id} failed: Summarization hit the token limit; the summary is incomplete`,
    ])
  } finally {
    await close()
    await harness.close(context)
  }
})
