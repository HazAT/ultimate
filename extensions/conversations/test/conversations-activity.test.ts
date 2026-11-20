import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { createRegistry, Harness, MemoryStorage, UsageDoc } from '@earendil-works/pi-durable'
import { expect, it } from 'vitest'
import type { ActionContext } from '../../../server/actions.ts'
import { context } from '../../../server/harness.ts'
import { actions } from '../server.ts'

it('reports own activity and spend for a conversation and its fork, including new entries', async () => {
  const harness = await Harness.open(
    new MemoryStorage(),
    { models: createModels(), registry: createRegistry() },
    context,
  )
  try {
    const root = await harness.root(context)
    const first = fauxAssistantMessage(
      [fauxText('Checking'), fauxToolCall('read', {}), fauxToolCall('read', {})],
      { timestamp: 20 },
    )
    const second = fauxAssistantMessage(fauxToolCall('edit', {}), { timestamp: 40 })
    const at = await harness.commit(async (tx) => {
      await tx.appendEntry(root.id, {
        kind: 'pi.user',
        model: [{ role: 'user', content: 'Check this', timestamp: 10 }],
      })
      await tx.appendEntry(root.id, { kind: 'pi.assistant', model: [first] })
      await tx.appendEntry(root.id, {
        kind: 'fixture.input',
        input: true,
        model: [{ role: 'user', content: 'Now fix it', timestamp: 30 }],
      })
      const entry = await tx.appendEntry(root.id, {
        kind: 'pi.assistant',
        model: [second, { role: 'user', content: 'A note, not an input', timestamp: 50 }],
      })
      const usage = await tx.doc(UsageDoc, root.id)
      usage.models['faux/faux-1'] = { ...first.usage, cost: { ...first.usage.cost, total: 0.5 } }
      usage.tools.read = { ...first.usage, cost: { ...first.usage.cost, total: 0.25 } }
      return entry.id
    }, context)
    const fork = await root.fork(at, { ownership: { kind: 'ownerless' } }, context)
    const read = () =>
      actions.activity({ ids: [root.id, fork.id, Number.MAX_SAFE_INTEGER] }, {
        host: { harness: () => harness },
        signal: new AbortController().signal,
      } as ActionContext)
    const rootStats = { turns: 2, calls: 3, cost: 0.75, lastAt: 50 }
    expect(await read()).toStrictEqual({
      [root.id]: rootStats,
      [fork.id]: { turns: 0, calls: 0, cost: 0 },
    })

    await harness.commit(
      (tx) =>
        tx.appendEntry(fork.id, {
          kind: 'pi.user',
          model: [{ role: 'user', content: 'Working in the fork', timestamp: 25 }],
        }),
      context,
    )
    expect(await read()).toStrictEqual({
      [root.id]: rootStats,
      [fork.id]: { turns: 1, calls: 0, cost: 0, lastAt: 25 },
    })
  } finally {
    await harness.close(context)
  }
})
