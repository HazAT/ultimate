import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { createRegistry, Harness, MemoryStorage } from '@earendil-works/pi-durable'
import type { Tx } from '@earendil-works/pi-durable'
import type { JsonValue } from '@earendil-works/chord/json'
import { expect, it } from 'vitest'
import { compactionEvents } from '../compactions.ts'
import { openers, until } from '../../../test/helpers.ts'
import { parseConversationId } from '../../../lib/ids.ts'

async function watched(storage = new MemoryStorage()) {
  const models = createModels()
  const faux = fauxProvider()
  models.setProvider(faux.provider)
  const harness = await Harness.open(storage, { models, registry: createRegistry() }, context)
  const model = faux.getModel()
  const root = await harness.root(context, {
    agent: { model: { provider: model.provider, modelId: model.id } },
  })
  const notices: string[] = []
  const emitted: unknown[] = []
  const resources = new Map<string, unknown>()
  const { onOpen, open, close } = openers()
  compactionEvents({
    harness: () => harness,
    emit: async (tx: Tx, _event: unknown, data: JsonValue) => {
      await tx.appendEntry(root.id, { kind: 'test.compacted', data })
      emitted.push(data)
    },
    onOpen,
    notice: (message: string) => notices.push(message),
    resource: (key: string, create: () => unknown) => {
      if (!resources.has(key)) resources.set(key, create())
      return resources.get(key)
    },
  } as unknown as Parameters<typeof compactionEvents>[0])
  await open()
  return { harness, root, faux, notices, emitted, close }
}

// A background compaction that failed was reported nowhere: the agent ran on until its blocking one failed the run.
it('a failed compaction its conversation owns raises a notice', async () => {
  const { harness, root, faux, notices, close } = await watched()
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

// The event was emitted in memory after Pi's commit: a process that stopped in between never announced the compaction,
// so automations on `conversations.compacted` never fired.
it('announces a compaction committed while it was not watching once, after reopening', async () => {
  const storage = new MemoryStorage()
  storage.close = async () => {}
  const compact = async (harness: Harness, id: number) =>
    (
      await harness.commit(
        (tx) => tx.appendEntry(parseConversationId(id), { kind: 'pi.compaction', head: 'self' }),
        context,
      )
    ).id
  const announced = async (harness: Harness, id: number) =>
    (
      await harness.commit(
        (tx) =>
          tx.scanEntries({ conversationId: parseConversationId(id), order: 'ascending' }, 100),
        context,
      )
    ).items.flatMap((entry) =>
      entry.kind === 'test.compacted' ? [(entry.data as { entry: number }).entry] : [],
    )
  const first = await watched(storage)
  const other = await first.harness.commit(
    (tx) => tx.createConversation({ ownership: { kind: 'ownerless' } }),
    context,
  )
  const watchedCompaction = await compact(first.harness, first.root.id)
  await until(() => first.emitted.length === 1)
  await first.close()
  const missedCompaction = await compact(first.harness, first.root.id)
  await first.harness.commit(
    (tx) => tx.appendEntry(other.id, { kind: 'pi.user', model: [] }),
    context,
  )
  await first.harness.close(context)
  for (let open = 0; open < 2; open++) {
    const again = await watched(storage)
    try {
      await again.close()
      expect(await announced(again.harness, again.root.id)).toEqual([
        watchedCompaction,
        missedCompaction,
      ])
    } finally {
      await again.harness.close(context)
    }
  }
})

// Typing the compaction payload (#590975) read `entry.data.reason` from a payload-less compaction entry; the throw
// detached the commit observer, so no later compaction was announced.
it('keeps announcing compactions after one without a payload', async () => {
  const { harness, root, emitted, close } = await watched()
  try {
    await harness.commit(
      (tx) => tx.appendEntry(root.id, { kind: 'pi.compaction', head: 'self' }),
      context,
    )
    await harness.commit(
      (tx) =>
        tx.appendEntry(root.id, {
          kind: 'pi.compaction',
          head: 'self',
          data: { reason: 'manual' },
        }),
      context,
    )
    await until(() => emitted.length === 2)
    expect(emitted).toMatchObject([
      { conversation: root.id },
      { conversation: root.id, reason: 'manual' },
    ])
  } finally {
    await close()
    await harness.close(context)
  }
})
