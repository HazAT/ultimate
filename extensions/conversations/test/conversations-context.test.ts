import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { estimateMessageTokens } from '@earendil-works/pi-ai/utils/estimate'
import { createRegistry, Harness, MemoryStorage } from '@earendil-works/pi-durable'
import type { ConversationId, EntryRecord } from '@earendil-works/pi-durable'
import { afterEach, expect, it } from 'vitest'
import { onCommit } from '../../../lib/commits.ts'
import { ContextUsageDoc } from '../api.ts'
import { contextBehavior } from '../context.ts'
import {
  contextUsage,
  estimateAfterHead,
  lastAssistant,
  promptTokens,
} from '../../../lib/context-usage.ts'
import { until } from '../../../test/helpers.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close()
})

async function fixture({ start = true } = {}) {
  const models = createModels()
  const faux = fauxProvider({
    models: [
      { id: 'small', contextWindow: 10000, maxTokens: 1024 },
      { id: 'large', contextWindow: 1000000, maxTokens: 1024 },
    ],
    tokensPerSecond: 100000,
  })
  let reply = fauxAssistantMessage('Answer')
  models.setProvider({
    ...faux.provider,
    streamSimple(model) {
      const stream = createAssistantMessageEventStream()
      const answer = { ...reply, provider: model.provider, model: model.id, api: model.api }
      queueMicrotask(() => {
        stream.push({ type: 'done', reason: 'stop', message: answer })
        stream.end(answer)
      })
      return stream
    },
  })
  const storage = new MemoryStorage()
  const harness = await Harness.open(storage, { models, registry: createRegistry() }, context)
  const root = await harness.root(context, {
    agent: { model: { provider: 'faux', modelId: 'small' } },
  })
  let open!: () => Promise<void>
  let close!: () => Promise<void>
  const notices: string[] = []
  const modelReads: string[] = []
  let failModelLookup = false
  contextBehavior({
    harness: () => harness,
    modelRuntime: {
      getModel: (provider, id) => {
        modelReads.push(`${provider}/${id}`)
        if (failModelLookup) throw new Error('Model runtime unavailable')
        return models.getModel(provider, id)
      },
    },
    onOpen: (callback) => {
      open = callback
    },
    onClose: (callback) => {
      close = callback
    },
    notice: (message) => {
      notices.push(message)
    },
  })
  if (start) await open()
  cleanups.push(async () => {
    await close()
    await harness.close(context)
    expect(notices).toEqual([])
  })
  const read = (id = root.id) => harness.snapshot(ContextUsageDoc, id, context)
  return {
    harness,
    root,
    respond: (answer: typeof reply) => {
      reply = answer
    },
    open,
    close,
    read,
    modelReads,
    notices,
    failModelLookup: (fail: boolean) => {
      failModelLookup = fail
    },
    async answer(input = 300) {
      const answer = fauxAssistantMessage('Answer')
      answer.usage = { ...answer.usage, input, cacheRead: 40, cacheWrite: 20 }
      reply = answer
      expect(
        (await (await root.submit({ type: 'input', content: 'Hello' }, context)).wait(context))
          .status,
      ).toBe('done')
      await until(async () => (await read())?.tokens === input + 60)
      return answer
    },
  }
}

it('publishes the same measured percentage as the old browser computation, without output tokens', async () => {
  const f = await fixture()
  await f.answer()
  const view = await f.root.context(context)
  const oldTokens = promptTokens(lastAssistant(view.entries).message!.usage)
  expect(await f.read()).toEqual({
    tokens: oldTokens,
    window: 10000,
    percent: (oldTokens / 10000) * 100,
    estimated: false,
    at: lastAssistant(view.entries).message!.timestamp,
    entry: view.entries.findLast((entry) => entry.kind === 'pi.assistant')!.id,
  })
})

it('marks kept answers stale by entry id, not their position after the head', () => {
  const record = (id: number, kind: string) =>
    ({
      id,
      kind,
      model: kind === 'pi.assistant' ? [fauxAssistantMessage('Answer')] : [],
    }) as unknown as EntryRecord
  const view = [record(9, 'pi.compaction'), record(4, 'pi.user'), record(5, 'pi.assistant')]
  expect(lastAssistant(view)).toEqual({ stale: true, marker: 9 })
  expect(lastAssistant([...view, record(10, 'pi.assistant')])).toMatchObject({
    stale: false,
    message: { role: 'assistant' },
  })
  expect(lastAssistant([record(2, 'pi.assistant')])).toMatchObject({ stale: false })
  expect(lastAssistant([])).toEqual({ stale: false })
})

it('estimates the prompt, tools, summary and kept entries once after compaction; the next answer measures it', async () => {
  const f = await fixture()
  const system = {
    role: 'system' as const,
    content: 'base',
    sections: { rules: 'r'.repeat(3500) },
    toolsAdded: [{ name: 'bash', description: 'd'.repeat(700), parameters: {} }],
    timestamp: 1,
  }
  const summary = { role: 'user' as const, content: 's'.repeat(700), timestamp: 4 }
  const keptMessage = { role: 'user' as const, content: 'k'.repeat(350), timestamp: 3 }
  const { kept, marker } = await f.harness.commit(async (tx) => {
    await tx.appendEntry(f.root.id, {
      kind: 'pi.user',
      model: [{ role: 'user', content: 'x'.repeat(7000), timestamp: 0 }],
    })
    await tx.appendEntry(f.root.id, { kind: 'pi.system', model: [system] })
    await tx.appendEntry(f.root.id, {
      kind: 'pi.assistant',
      model: [fauxAssistantMessage('Old answer')],
    })
    const first = await tx.appendEntry(f.root.id, { kind: 'pi.user', model: [keptMessage] })
    const head = await tx.appendEntry(f.root.id, {
      kind: 'pi.compaction',
      head: first.id,
      data: { reason: 'manual' },
      model: [summary],
    })
    return { kept: first, marker: head }
  }, context)
  await until(async () => (await f.read())?.entry === marker.id)
  const expected =
    estimateMessageTokens(system) +
    estimateMessageTokens(summary) +
    estimateMessageTokens(keptMessage)
  expect(await f.read()).toEqual({
    ...contextUsage({ tokens: expected, window: 10000, estimated: true }, summary.timestamp),
    entry: marker.id,
  })
  expect(expected).toBeLessThan(2000)
  const again = await f.harness.commit(async (tx) => {
    await tx.appendEntry(f.root.id, { kind: 'pi.system', model: [{ ...system, timestamp: 5 }] })
    return tx.appendEntry(f.root.id, {
      kind: 'pi.compaction',
      head: kept.id,
      data: { reason: 'manual' },
      model: [{ ...summary, timestamp: 6 }],
    })
  }, context)
  await until(async () => (await f.read())?.entry === again.id)
  expect((await f.read())?.tokens).toBe(expected)
  const estimated = await f.read()
  await f.harness.commit(
    (tx) =>
      tx.appendEntry(f.root.id, {
        kind: 'pi.user',
        model: [{ role: 'user', content: 'Later input', timestamp: 7 }],
      }),
    context,
  )
  await f.root.configure({ model: { provider: 'faux', modelId: 'large' } }, context)
  await until(async () => (await f.read())?.window === 1000000)
  expect(await f.read()).toEqual({
    ...estimated,
    window: 1000000,
    percent: (expected / 1000000) * 100,
  })
  await f.answer(500)
  expect(await f.read()).toMatchObject({ tokens: 560, estimated: false })
})

it('estimates a reset from the previous system baseline and the new handoff', async () => {
  const f = await fixture()
  await f.answer()
  const previous = await f.root.context(context)
  await f.root.reset('Continue from this handoff.', context)
  const current = await f.root.context(context)
  await until(async () => (await f.read())?.entry === current.head!.id)
  expect(await f.read()).toEqual({
    ...contextUsage(
      {
        tokens: estimateAfterHead(previous.messages, current.messages),
        window: 10000,
        estimated: true,
      },
      current.head!.model![0].timestamp,
    ),
    entry: current.head!.id,
  })
  const beforeReset = Date.now()
  await f.root.reset(undefined, context)
  const empty = await f.root.context(context)
  await until(async () => (await f.read())?.entry === empty.head!.id)
  expect((await f.read())?.estimated).toBe(true)
  expect((await f.read())?.at).toBeGreaterThanOrEqual(beforeReset)
  expect((await f.read())?.at).toBeLessThanOrEqual(Date.now())
})

it('updates the model window, clears unknown windows, and does not write for unrelated agent changes', async () => {
  const f = await fixture()
  await f.answer()
  const measured = await f.read()
  await f.root.configure({ model: { provider: 'faux', modelId: 'large' } }, context)
  await until(async () => (await f.read())?.window === 1000000)
  expect(await f.read()).toEqual({ ...measured, window: 1000000, percent: (360 / 1000000) * 100 })
  let writes = 0
  const stop = onCommit(f.harness, (publication) => {
    writes += publication.changes.filter(
      (change) =>
        change.type === 'document' && change.record.kind === ContextUsageDoc.definition.kind,
    ).length
  })
  const reads = f.modelReads.length
  await f.root.configure({ instructions: 'Changed instructions' }, context)
  await until(() => f.modelReads.length > reads)
  // Model lookup happens inside the projection's commit; a snapshot fences that commit's publication.
  await f.read()
  expect(writes).toBe(0)
  stop()
  await f.root.configure({ model: { provider: 'missing', modelId: 'unknown' } }, context)
  await until(async () => (await f.read())?.window === undefined)
  expect(await f.read()).toEqual({
    tokens: 360,
    estimated: false,
    at: measured!.at,
    entry: measured!.entry,
  })
})

it('reports projection failures and recovers on the next agent commit without overwriting the last measure', async () => {
  const f = await fixture()
  await f.answer()
  const measured = await f.read()
  f.failModelLookup(true)
  await f.root.configure({ model: { provider: 'faux', modelId: 'large' } }, context)
  await until(() => f.notices.length > 0)
  expect(f.notices.splice(0)).toEqual(['Conversation context: Error: Model runtime unavailable'])
  expect(await f.read()).toEqual(measured)
  f.failModelLookup(false)
  await f.root.configure({ instructions: 'Try again' }, context)
  await until(async () => (await f.read())?.window === 1000000)
  expect((await f.read())?.tokens).toBe(measured!.tokens)
})

it('starts forks at initial, including backfill, until their own answer', async () => {
  const f = await fixture()
  await f.answer()
  const view = await f.root.context(context)
  const fork = await f.root.fork(
    view.entries.at(-1)!.id,
    { ownership: { kind: 'ownerless' } },
    context,
  )
  expect(
    await f.harness.commit(
      async (tx) => ({ ...(await tx.doc(ContextUsageDoc, fork.id)) }),
      context,
    ),
  ).toEqual({
    at: 0,
  })
  await f.close()
  const sentinel = await f.harness.commit(async (tx) => {
    const record = await tx.createConversation({ ownership: { kind: 'ownerless' } })
    await tx.appendEntry(record.id, {
      kind: 'pi.assistant',
      model: [fauxAssistantMessage('Sentinel')],
    })
    return record.id
  }, context)
  await f.open()
  await until(async () => ((await f.read(sentinel))?.entry ?? 0) > 0)
  await f.close()
  expect(await f.read(fork.id)).toEqual({ at: 0 })
  await f.open()
  const answer = fauxAssistantMessage('Fork answer')
  answer.usage = { ...answer.usage, input: 120 }
  f.respond(answer)
  await (await fork.submit({ type: 'input', content: 'Continue' }, context)).wait(context)
  await until(async () => (await f.read(fork.id))?.tokens === 120)
})

it('backfills missing and stale docs in bounded pages, in the background, and skips unchanged docs', async () => {
  const f = await fixture({ start: false })
  const ids = await f.harness.commit(async (tx) => {
    const created: ConversationId[] = []
    for (let index = 0; index < 65; index++) {
      const conversation = await tx.createConversation({ ownership: { kind: 'ownerless' } })
      await tx.appendEntry(conversation.id, {
        kind: 'pi.assistant',
        model: [fauxAssistantMessage('Recovered answer')],
      })
      created.push(conversation.id)
    }
    return created
  }, context)
  const answer = fauxAssistantMessage('Missed answer')
  answer.usage = { ...answer.usage, input: 500 }
  await f.harness.commit(
    (tx) => tx.appendEntry(f.root.id, { kind: 'pi.assistant', model: [answer] }),
    context,
  )
  await f.open()
  await until(async () => ((await f.read(ids.at(-1)))?.at ?? 0) > 0)
  expect((await f.read())?.tokens).toBe(500)
  await f.close()
  answer.usage.input = 900
  const latest = await f.harness.commit(
    (tx) => tx.appendEntry(f.root.id, { kind: 'pi.assistant', model: [answer] }),
    context,
  )
  await f.open()
  await until(async () => (await f.read())?.entry === latest.id)
  expect((await f.read())?.tokens).toBe(900)
  await f.close()
  let writes = 0
  const stop = onCommit(f.harness, (publication) => {
    writes += publication.changes.filter(
      (change) =>
        change.type === 'document' && change.record.kind === ContextUsageDoc.definition.kind,
    ).length
  })
  const reads = f.modelReads.length
  await f.open()
  await until(() => f.modelReads.length > reads)
  await f.read()
  await f.close()
  expect(writes).toBe(0)
  stop()
})
