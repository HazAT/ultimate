import { awaitWithContext } from '@earendil-works/chord/context'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import {
  createRegistry,
  defineExtension,
  GenerationTask,
  hook,
  Harness,
  MemoryStorage,
  UsageDoc,
} from '@earendil-works/pi-durable'
import { afterEach, expect, it } from 'vitest'
import { onCommit } from '../../../lib/commits.ts'
import { context } from '../../../server/harness.ts'
import { Metadata } from '../../../server/metadata.ts'
import { IntentSummarized, Summaries, summaryBehavior, TitleChanged } from '../summary.ts'
import { until } from '../../../test/helpers.ts'

const reported = {
  input: 300,
  output: 100,
  cacheRead: 10,
  cacheWrite: 0,
  totalTokens: 410,
  reasoning: 40,
  cacheWrite1h: 6,
  cost: { input: 0.03, output: 0.05, cacheRead: 0.001, cacheWrite: 0, total: 0.081 },
}
const key = 'openai-codex/gpt-6-luna'
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close()
})

async function launch({ interrupt = false, long = false, initialIntent = false } = {}) {
  const models = createModels()
  const main = fauxProvider({ tokensPerSecond: 100000 })
  const luna = fauxProvider({
    provider: 'openai-codex',
    models: [{ id: 'gpt-6-luna', reasoning: true }],
  })
  models.setProvider(main.provider)
  models.setProvider({
    ...luna.provider,
    streamSimple(model) {
      const stream = createAssistantMessageEventStream()
      const answer = {
        ...fauxAssistantMessage(
          JSON.stringify({
            activity: 'Implemented the change.',
            title: 'Implement the change',
            summary: long ? 'x'.repeat(3000) : 'Implemented the change.',
          }),
        ),
        provider: model.provider,
        model: model.id,
        api: model.api,
        usage: reported,
      }
      if (long)
        stream.push({
          type: 'text_delta',
          contentIndex: 0,
          delta: 'x'.repeat(3000),
          partial: fauxAssistantMessage('x'.repeat(3000)),
        })
      queueMicrotask(() => {
        stream.push({ type: 'done', reason: 'stop', message: answer })
        stream.end(answer)
      })
      return stream
    },
  })
  const storage = new MemoryStorage()
  storage.close = async () => {}
  const registry = createRegistry()
  let harness: Harness
  const behavior = summaryBehavior({
    harness: () => harness,
    metadata: Metadata,
    userHome: '/nonexistent',
    projectSettings: async () => ({}),
    notice: () => {},
    modelRuntime: {
      getAvailableSnapshot: () =>
        models.getModels().filter((model) => model.provider === 'openai-codex'),
    },
  })
  let release!: () => void
  const gate = new Promise<void>((done) => {
    release = done
  })
  registry.install(
    defineExtension({
      name: 'conversations',
      ...behavior,
      hooks: [
        ...behavior.hooks,
        ...(initialIntent
          ? [
              hook(GenerationTask, {
                beforeRequest: async (_request, _api, caller) => {
                  await awaitWithContext(gate, caller)
                  return undefined
                },
              }),
            ]
          : []),
      ],
    }),
  )
  harness = await Harness.open(storage, { models, registry }, context)
  let interruption: Promise<void> | undefined
  onCommit(harness, (publication) => {
    if (
      interrupt &&
      !interruption &&
      publication.changes.some(
        (change) => change.type === 'task' && change.value.memos?.response !== undefined,
      )
    )
      interruption = harness.close(context)
  })
  let root = await harness.root(context, {
    agent: { model: { provider: 'faux', modelId: 'faux-1' } },
  })
  if (!initialIntent)
    await harness.commit(
      (tx) =>
        tx.appendEntry(root.id, {
          kind: 'pi.user',
          model: [{ role: 'user', content: 'Established context', timestamp: 1 }],
        }),
      context,
    )
  cleanups.push(async () => {
    release()
    await harness.close(context)
  })
  const read = () => harness.snapshot(Summaries, root.id, context)
  const ledger = () => harness.snapshot(UsageDoc, root.id, context)
  const submit = async () => {
    main.setResponses([fauxAssistantMessage('Implemented the change.')])
    expect(
      (
        await (
          await root.submit({ type: 'input', content: 'Implement this change.' }, context)
        ).wait(context)
      ).status,
    ).toBe('done')
  }
  return {
    read,
    ledger,
    release,
    begin: () => {
      main.setResponses([fauxAssistantMessage('Implemented the change.')])
      return root.submit({ type: 'input', content: 'Implement this change.' }, context)
    },
    intents: async () =>
      (await root.context(context)).entries.filter((entry) => IntentSummarized.is(entry)),
    titleChanges: async () =>
      (await root.context(context)).entries.filter((entry) => TitleChanged.is(entry)),
    submit,
    interrupted: () => interruption !== undefined,
    reopen: async () => {
      await (interruption ?? harness.close(context))
      interruption = undefined
      harness = await Harness.open(storage, { models, registry }, context)
      root = await harness.root(context)
      harness.resume()
    },
  }
}

it('adds reported usage once, also on replay', async () => {
  const f = await launch({ interrupt: true })
  await f.submit()
  await until(f.interrupted)
  await f.reopen()
  await until(async () => (await f.read())?.status === 'ready')
  expect((await f.ledger())?.models[key]).toEqual(reported)
  const changes = await f.titleChanges()
  expect(changes).toHaveLength(1)
  expect(changes[0].data.title).toBe('Implement the change')
  await f.reopen()
  expect(await f.titleChanges()).toEqual(changes)
  await f.submit()
  await until(async () => (await f.read())?.exchanges === 2 && !(await f.read())?.pending)
  const total = (await f.ledger())!.models[key]
  expect(total.totalTokens).toBe(820)
  expect(total.reasoning).toBe(80)
  expect(total.cacheWrite1h).toBe(12)
  expect(total.cost.total).toBeCloseTo(0.162)
  expect(await f.titleChanges()).toEqual(changes)
})

it('generates a title and reply summary with only current Codex Luna available', async () => {
  const f = await launch()
  await f.submit()
  await until(async () => (await f.read())?.status === 'ready')
  expect((await f.read())?.activity).toBe('Implemented the change.')
  expect((await f.read())?.generatedTitle).toBe('Implement the change')
  expect((await f.titleChanges()).map((entry) => entry.data.title)).toEqual([
    'Implement the change',
  ])
  expect((await f.ledger())?.models[key]).toEqual(reported)
  expect((await f.ledger())?.models['openai/gpt-6-luna']).toBeUndefined()
})

it('a response with usage after a long stream still counts', async () => {
  const f = await launch({ long: true })
  await f.submit()
  await until(async () => (await f.read())?.status === 'ready')
  expect((await f.ledger())?.models[key]).toEqual(reported)
  expect((await f.read())?.summary).toHaveLength(420)
})

it('replays an initial intent response receipt once while the main generation remains blocked', async () => {
  const f = await launch({ interrupt: true, initialIntent: true })
  await f.begin()
  await until(f.interrupted)
  await f.reopen()
  await until(async () => (await f.read())?.status === 'ready')
  expect((await f.read())?.exchanges).toBe(0)
  expect((await f.ledger())?.models[key]).toEqual(reported)
  const entries = await f.intents()
  expect(entries).toHaveLength(1)
  expect(entries[0].model).toBeUndefined()
  await f.reopen()
  expect(await f.intents()).toEqual(entries)
  expect((await f.ledger())?.models[key]).toEqual(reported)
  f.release()
  await until(async () => (await f.read())?.exchanges === 1 && !(await f.read())?.pending)
  expect((await f.ledger())?.models[key].totalTokens).toBe(820)
  expect(await f.intents()).toEqual(entries)
})
