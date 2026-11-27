import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import type { Api, Model, SimpleStreamOptions } from '@earendil-works/pi-ai'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import type { ConversationId, EntryId, Tx } from '@earendil-works/pi-durable'
import {
  createRegistry,
  defineExtension,
  Harness,
  MemoryStorage,
  UsageDoc,
} from '@earendil-works/pi-durable'
import { afterEach, expect, it, vi } from 'vitest'
import { context } from '../../../server/harness.ts'
import { Metadata } from '../../../server/metadata.ts'
import type { TreesService } from '../api.ts'
import { SummaryDiscarded, TitleChanged } from '../entries.ts'
import {
  SUMMARY_RETRY_DELAYS_MS,
  Summaries,
  summaryBehavior,
  type SummaryHost,
} from '../summary.ts'
import { until } from '../../../test/helpers.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close()
})

const attemptUsage = {
  input: 100,
  output: 50,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 150,
  cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
}

type ScriptedResponse =
  | { kind: 'ok'; title?: string; summary?: string; activity?: string; abstract?: string }
  | { kind: 'length'; text?: string }
  | { kind: 'error'; message?: string }
  | { kind: 'throw'; message: string }
  | { kind: 'raw'; text: string }

async function launch(
  script: () => ScriptedResponse,
  { maxTokens = 6000, branch = true }: { maxTokens?: number; branch?: boolean } = {},
) {
  let now = 1_000_000
  const models = createModels()
  const main = fauxProvider({ tokensPerSecond: 100000 })
  const luna = fauxProvider({
    provider: 'openai-codex',
    models: [{ id: 'gpt-6-luna', reasoning: true, maxTokens }],
  })
  const requests: { maxTokens?: number }[] = []
  let providerRemoved = false
  models.setProvider(main.provider)
  models.setProvider({
    ...luna.provider,
    streamSimple(model: Model<Api>, _context: unknown, options?: SimpleStreamOptions) {
      requests.push({ maxTokens: options?.maxTokens })
      const next = script()
      if (next.kind === 'throw') throw new Error(next.message)
      const stream = createAssistantMessageEventStream()
      if (next.kind === 'error') {
        const answer = {
          ...fauxAssistantMessage('', {
            stopReason: 'error',
            errorMessage: next.message ?? 'Provider offline',
          }),
          provider: model.provider,
          model: model.id,
          api: model.api,
          usage: attemptUsage,
        }
        queueMicrotask(() => {
          stream.push({ type: 'error', reason: 'error', error: answer })
          stream.end(answer)
        })
        return stream
      }
      if (next.kind === 'length') {
        const answer = {
          ...fauxAssistantMessage(next.text ?? '{"activity":"Truncated', {
            stopReason: 'length',
          }),
          provider: model.provider,
          model: model.id,
          api: model.api,
          usage: attemptUsage,
        }
        queueMicrotask(() => {
          stream.push({ type: 'done', reason: 'length', message: answer })
          stream.end(answer)
        })
        return stream
      }
      const text =
        next.kind === 'raw'
          ? next.text
          : JSON.stringify({
              activity: next.activity ?? 'Updated the summary.',
              title: next.title ?? 'Retry summary work',
              summary: next.summary ?? 'Retried and summarized the conversation.',
              ...(branch
                ? {
                    abstract: next.abstract ?? 'Ask: fix retries\nDiverged: none\nState: done',
                  }
                : {}),
            })
      const answer = {
        ...fauxAssistantMessage(text),
        provider: model.provider,
        model: model.id,
        api: model.api,
        usage: attemptUsage,
      }
      queueMicrotask(() => {
        stream.push({ type: 'done', reason: 'stop', message: answer })
        stream.end(answer)
      })
      return stream
    },
  })
  const abstract = vi.fn<
    (tx: Tx, id: ConversationId, data: { text: string; at: EntryId }) => Promise<void>
  >(async () => {})
  const storage = new MemoryStorage()
  storage.close = async () => {}
  const registry = createRegistry()
  let harness: Harness
  const host: SummaryHost = {
    harness: () => harness,
    metadata: Metadata,
    userHome: '/nonexistent',
    projectSettings: async () => ({}),
    notice: () => {},
    modelRuntime: {
      getAvailableSnapshot: () =>
        providerRemoved
          ? []
          : models.getModels().filter((model) => model.provider === 'openai-codex'),
    },
    want: ((api: { name: string }) =>
      api.name === 'conversations.trees' && branch
        ? ({
            isRoot: async () => false,
            rootOf: async () => undefined,
            branchOf: async () => ({
              root: 1 as ConversationId,
              intent: 'Fix summary retries',
            }),
            abstract,
          } satisfies TreesService)
        : undefined) as NonNullable<SummaryHost['want']>,
  }
  registry.install(defineExtension({ name: 'conversations', ...summaryBehavior(host) }))
  const options = {
    models,
    registry,
    now: () => now,
    setTimer: () => () => {},
  }
  harness = await Harness.open(storage, options, context)
  let root = await harness.root(context, {
    agent: { model: { provider: 'faux', modelId: 'faux-1' } },
  })
  await harness.commit(
    (tx) =>
      tx.appendEntry(root.id, {
        kind: 'pi.user',
        model: [{ role: 'user', content: 'Established context', timestamp: 1 }],
      }),
    context,
  )
  cleanups.push(() => harness.close(context))

  const summaryTasks = async () =>
    (
      await harness.commit(
        (tx) => tx.scanTasks({ conversationId: root.id, kind: 'conversations.summary' }, 100),
        context,
      )
    ).items

  return {
    get harness() {
      return harness
    },
    get root() {
      return root
    },
    models,
    requests,
    abstract,
    now: () => now,
    advance: (ms: number) => {
      now += ms
      harness.resume()
    },
    removeSummaryModel: () => {
      providerRemoved = true
      models.deleteProvider('openai-codex')
    },
    read: () => harness.snapshot(Summaries, root.id, context),
    ledger: () => harness.snapshot(UsageDoc, root.id, context),
    entries: async () =>
      (await harness.commit((tx) => tx.scanEntries({ conversationId: root.id }, 200), context))
        .items,
    summaryTasks,
    sleeping: async (attempt: number) => {
      let found: Awaited<ReturnType<typeof summaryTasks>>[number] | undefined
      await until(async () => {
        found = (await summaryTasks()).find(
          (task) =>
            task.state.status === 'sleeping' &&
            (task.state.checkpoint as { attempt?: number }).attempt === attempt,
        )
        return found !== undefined
      })
      return found!
    },
    submit: async (content = 'Continue the work.') => {
      main.setResponses([fauxAssistantMessage('Finished this step.')])
      const submission = await root.submit({ type: 'input', content }, context)
      expect((await submission.wait(context)).status).toBe('done')
    },
    reopen: async () => {
      await harness.close(context)
      harness = await Harness.open(storage, options, context)
      root = await harness.root(context)
      harness.resume()
    },
  }
}

it('retries transient and malformed summary failures durably and succeeds without marking error', async () => {
  const responses: ScriptedResponse[] = [
    { kind: 'throw', message: 'Transient gateway timeout' },
    { kind: 'raw', text: '{not valid json' },
    { kind: 'ok', summary: 'Recovered on attempt 3.' },
  ]
  const f = await launch(() => responses.shift() ?? { kind: 'ok' })
  await f.submit()

  const firstSleep = await f.sleeping(1)
  expect(firstSleep.state).toMatchObject({
    status: 'sleeping',
    until: f.now() + SUMMARY_RETRY_DELAYS_MS[0],
    checkpoint: { phase: 'generate', attempt: 1 },
  })
  expect((await f.read())?.status).toBe('pending')
  expect((await f.read())?.assessmentStatus).toBe('pending')
  expect((await f.entries()).filter((entry) => SummaryDiscarded.is(entry))).toEqual([])

  await f.reopen()
  f.advance(SUMMARY_RETRY_DELAYS_MS[0])

  const secondSleep = await f.sleeping(2)
  expect(secondSleep.state).toMatchObject({
    status: 'sleeping',
    until: f.now() + SUMMARY_RETRY_DELAYS_MS[1],
    checkpoint: { phase: 'generate', attempt: 2 },
  })

  f.advance(SUMMARY_RETRY_DELAYS_MS[1])
  await until(async () => (await f.read())?.status === 'ready')

  const state = await f.read()
  expect(state?.assessmentStatus).toBe('ready')
  expect(state?.summary).toBe('Recovered on attempt 3.')
  expect(f.requests).toHaveLength(3)
  expect(f.abstract).toHaveBeenCalledTimes(1)
  expect((await f.entries()).filter((entry) => SummaryDiscarded.is(entry))).toEqual([])
  expect((await f.ledger())?.models['openai-codex/gpt-6-luna']?.totalTokens).toBe(300)
})

it('doubles maxTokens on length truncation, clamped to model.maxTokens, and succeeds on retry', async () => {
  const responses: ScriptedResponse[] = [
    { kind: 'length' },
    { kind: 'length' },
    { kind: 'ok', summary: 'Fit inside the expanded budget.' },
  ]
  const f = await launch(() => responses.shift() ?? { kind: 'ok' }, { maxTokens: 6000 })
  await f.submit()

  const firstSleep = await f.sleeping(1)
  expect(firstSleep.state).toMatchObject({
    status: 'sleeping',
    checkpoint: { phase: 'generate', attempt: 1, maxTokens: 4096 },
  })
  f.advance(SUMMARY_RETRY_DELAYS_MS[0])

  const secondSleep = await f.sleeping(2)
  expect(secondSleep.state).toMatchObject({
    status: 'sleeping',
    checkpoint: { phase: 'generate', attempt: 2, maxTokens: 6000 },
  })
  f.advance(SUMMARY_RETRY_DELAYS_MS[1])

  await until(async () => (await f.read())?.status === 'ready')
  expect(f.requests.map((request) => request.maxTokens)).toEqual([2048, 4096, 6000])
  expect((await f.read())?.summary).toBe('Fit inside the expanded budget.')
  expect(f.abstract).toHaveBeenCalledTimes(1)
  expect((await f.entries()).filter((entry) => SummaryDiscarded.is(entry))).toEqual([])
  expect((await f.ledger())?.models['openai-codex/gpt-6-luna']?.totalTokens).toBe(450)
})

it('records error and summary-discarded once retries are exhausted, then recovers on the next reply', async () => {
  let failRemaining = SUMMARY_RETRY_DELAYS_MS.length + 1
  const f = await launch(() =>
    failRemaining-- > 0
      ? { kind: 'throw', message: 'Provider offline' }
      : { kind: 'ok', summary: 'Recovered on the next exchange.' },
  )
  await f.submit()

  for (const [index, delay] of SUMMARY_RETRY_DELAYS_MS.entries()) {
    await f.sleeping(index + 1)
    f.advance(delay)
  }
  await until(async () => (await f.read())?.status === 'error')

  expect((await f.read())?.assessmentStatus).toBe('error')
  expect((await f.read())?.summary).toBeUndefined()
  expect(f.abstract).not.toHaveBeenCalled()
  expect((await f.entries()).filter((entry) => TitleChanged.is(entry))).toEqual([])
  expect(
    (await f.entries()).filter((entry) => SummaryDiscarded.is(entry)).map((e) => e.data),
  ).toEqual([
    {
      reason: 'error',
      cause: 'Summary request did not finish',
      model: 'openai-codex/gpt-6-luna',
      at: expect.any(Number),
    },
  ])
  expect(f.requests).toHaveLength(SUMMARY_RETRY_DELAYS_MS.length + 1)

  await f.submit('Try again after outage.')
  await until(async () => (await f.read())?.status === 'ready')
  expect((await f.read())?.summary).toBe('Recovered on the next exchange.')
  expect(f.abstract).toHaveBeenCalledTimes(1)
})

it('does not retry when the chosen summary model becomes unavailable', async () => {
  const responses: ScriptedResponse[] = [{ kind: 'error', message: 'Temporary error' }]
  const f = await launch(() => responses.shift() ?? { kind: 'ok' })
  await f.submit()

  await f.sleeping(1)
  f.removeSummaryModel()
  f.advance(SUMMARY_RETRY_DELAYS_MS[0])

  await until(async () => (await f.read())?.status === 'error')
  expect(f.requests).toHaveLength(1)
  expect(
    (await f.entries()).filter((entry) => SummaryDiscarded.is(entry)).map((e) => e.data),
  ).toEqual([
    {
      reason: 'error',
      cause: 'Summary model openai-codex/gpt-6-luna is unavailable',
      model: 'openai-codex/gpt-6-luna',
      at: expect.any(Number),
    },
  ])
})

it('stops retrying immediately when a revision bump or newer summary supersedes a sleeping task', async () => {
  const responses: ScriptedResponse[] = [
    { kind: 'throw', message: 'First attempt blip' },
    { kind: 'throw', message: 'Second exchange blip' },
    { kind: 'ok', summary: 'Third exchange summary.' },
  ]
  const f = await launch(() => responses.shift() ?? { kind: 'ok' })
  await f.submit('First input.')
  const firstSleep = await f.sleeping(1)
  expect(f.requests).toHaveLength(1)

  await f.harness.commit(async (tx) => {
    ;(await tx.doc(Summaries, f.root.id)).revision++
  }, context)
  f.advance(SUMMARY_RETRY_DELAYS_MS[0])

  await until(
    async () =>
      (await f.summaryTasks()).find((task) => task.id === firstSleep.id)?.state.status ===
      'terminal',
  )
  expect(f.requests).toHaveLength(1)
  expect((await f.entries()).filter((entry) => SummaryDiscarded.is(entry))).toEqual([])

  await f.submit('Second input.')
  const secondSleep = await f.sleeping(1)
  expect(f.requests).toHaveLength(2)

  await f.submit('Third input.')
  await until(async () => (await f.read())?.status === 'ready')
  expect((await f.read())?.summary).toBe('Third exchange summary.')
  expect(f.requests).toHaveLength(3)

  f.advance(SUMMARY_RETRY_DELAYS_MS[0])
  await until(
    async () =>
      (await f.summaryTasks()).find((task) => task.id === secondSleep.id)?.state.status ===
      'terminal',
  )
  expect(f.requests).toHaveLength(3)
  expect((await f.read())?.summary).toBe('Third exchange summary.')
  expect((await f.entries()).filter((entry) => SummaryDiscarded.is(entry))).toEqual([])
})
