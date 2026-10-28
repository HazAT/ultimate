import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import type { Api, Model, SimpleStreamOptions } from '@earendil-works/pi-ai'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import type { JsonObject } from '@earendil-works/pi-durable'
import {
  createRegistry,
  defineExtension,
  Harness,
  MemoryStorage,
  UsageDoc,
} from '@earendil-works/pi-durable'
import { afterEach, expect, it } from 'vitest'
import type { ActionContext } from '../server/actions.ts'
import { context } from '../server/harness.ts'
import { Metadata } from '../server/metadata.ts'
import { actions } from '../extensions/conversations/server.ts'
import { parseSummaryModel } from '../extensions/conversations/summary-model-ref.ts'
import {
  IntentSummarized,
  ReplySummarized,
  requestSummary,
  SpawnSummarized,
  Summaries,
  SummaryDiscarded,
  summaryBehavior,
  TitleChanged,
} from '../extensions/conversations/summary.ts'
import type { SummaryHost } from '../extensions/conversations/summary.ts'
import { temp, until } from './helpers.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close()
})

/** A summary provider whose models answer with a valid reply summary; `requests` records what was asked. */
function summaryProvider(provider: string, ids: string[]) {
  const handle = fauxProvider({ provider, models: ids.map((id) => ({ id, reasoning: true })) })
  const requests: { model: string; reasoning: SimpleStreamOptions['reasoning'] }[] = []
  return {
    requests,
    provider: {
      ...handle.provider,
      streamSimple(model: Model<Api>, _context: unknown, options?: SimpleStreamOptions) {
        requests.push({ model: `${model.provider}/${model.id}`, reasoning: options?.reasoning })
        const stream = createAssistantMessageEventStream()
        const answer = {
          ...fauxAssistantMessage(
            JSON.stringify({
              activity: 'Implemented the change.',
              title: 'Implement the change',
              summary: 'Implemented the change.',
            }),
          ),
          provider: model.provider,
          model: model.id,
          api: model.api,
        }
        queueMicrotask(() => {
          stream.push({ type: 'done', reason: 'stop', message: answer })
          stream.end(answer)
        })
        return stream
      },
    } as typeof handle.provider,
  }
}

async function launch({
  user,
  project = {},
  available = (model: Model<Api>) => model.provider !== 'faux',
  interrupt,
  established = true,
}: {
  user?: JsonObject
  project?: JsonObject
  available?: (model: Model<Api>) => boolean
  /** Close the harness once the summary task memoizes its model, or when it is about to ask one. */
  interrupt?: 'model' | 'generate'
  established?: boolean
} = {}) {
  const userHome = await temp('ultimate-summary-model-')
  if (user) {
    await mkdir(join(userHome, '.ultimate'))
    await writeFile(join(userHome, '.ultimate/settings.json'), JSON.stringify(user))
  }
  const models = createModels()
  const main = fauxProvider({ tokensPerSecond: 100000 })
  const luna = summaryProvider('openai-codex', ['gpt-6-luna'])
  const acme = summaryProvider('acme', ['mini', 'large'])
  models.setProvider(main.provider)
  models.setProvider(luna.provider)
  models.setProvider(acme.provider)
  const notices: string[] = []
  const settings = { project }
  const storage = new MemoryStorage()
  storage.close = async () => {}
  const registry = createRegistry()
  let harness: Harness
  const host: SummaryHost = {
    harness: () => harness,
    metadata: Metadata,
    userHome,
    projectSettings: async () => settings.project,
    notice: (message) => notices.push(message),
    modelRuntime: { getAvailableSnapshot: () => models.getModels().filter(available) },
  }
  registry.install(defineExtension({ name: 'conversations', ...summaryBehavior(host) }))
  harness = await Harness.open(storage, { models, registry }, context)
  let interruption: Promise<void> | undefined
  harness.subscribeCommits((publication) => {
    if (
      !interruption &&
      publication.changes.some(
        (change) =>
          change.type === 'task' &&
          (interrupt === 'model'
            ? change.value.memos?.model !== undefined
            : interrupt === 'generate' &&
              change.value.state.status === 'running' &&
              (change.value.state.checkpoint as { phase?: string } | undefined)?.phase ===
                'generate'),
      )
    )
      interruption = harness.close(context)
  })
  let root = await harness.root(context, {
    agent: { model: { provider: 'faux', modelId: 'faux-1' } },
  })
  if (established)
    await harness.commit(
      (tx) =>
        tx.appendEntry(root.id, {
          kind: 'pi.user',
          model: [{ role: 'user', content: 'Established context', timestamp: 1 }],
        }),
      context,
    )
  cleanups.push(() => harness.close(context))
  return {
    userHome,
    settings,
    notices,
    requests: () => [...luna.requests, ...acme.requests],
    read: () => harness.snapshot(Summaries, root.id, context),
    tasks: async () => (await harness.inspect(context)).tasks,
    assessed: async () =>
      (await root.context(context)).entries.flatMap((entry) =>
        ReplySummarized.is(entry) ? [entry.data] : [],
      ),
    entries: async () => (await root.context(context)).entries,
    /** Request a spawn refresh for the latest answer, as a subagent start does. */
    spawn: async () => {
      const answer = (await harness.snapshot(Summaries, root.id, context))!.lastAnswer!
      await harness.commit(
        (tx) =>
          requestSummary(
            tx,
            host,
            root.id,
            { reason: 'spawn', answer, agent: 'scout', task: 'Continue.' },
            { provider: 'acme', id: 'large', thinking: 'medium' },
          ),
        context,
      )
    },
    rename: (title: string) =>
      harness.commit(async (tx) => {
        delete (await tx.doc(Summaries, root.id)).generatedTitle
        ;(await tx.doc(Metadata, root.id)).title = title
      }, context),
    ledger: async () =>
      Object.keys((await harness.snapshot(UsageDoc, root.id, context))?.models ?? {}),
    submit: async () => {
      main.setResponses([fauxAssistantMessage('Implemented the change.')])
      const submission = await root.submit(
        { type: 'input', content: 'Implement this change.' },
        context,
      )
      expect((await submission.wait(context)).status).toBe('done')
    },
    task: (id: Parameters<Harness['getTask']>[0]) => harness.getTask(id, context),
    title: async () => (await harness.snapshot(Metadata, root.id, context))?.title,
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

it('asks the configured summary model with its thinking level and records it', async () => {
  const f = await launch({ user: { summaryModel: 'acme/mini:low' } })
  await f.submit()
  await until(async () => (await f.read())?.assessmentStatus === 'ready')
  expect(f.requests()).toEqual([{ model: 'acme/mini', reasoning: 'low' }])
  expect(await f.assessed()).toMatchObject([
    { activity: 'Implemented the change.', model: 'acme/mini' },
  ])
  expect(await f.ledger()).toEqual(['faux/faux-1', 'acme/mini'])
})

it('uses the tiny family, GPT-6 Luna with low thinking, when no summary model is set', async () => {
  const f = await launch()
  await f.submit()
  await until(async () => (await f.read())?.assessmentStatus === 'ready')
  expect(f.requests()).toEqual([{ model: 'openai-codex/gpt-6-luna', reasoning: 'low' }])
  expect(await f.assessed()).toMatchObject([{ model: 'openai-codex/gpt-6-luna' }])
})

it("lets the project's summary model override the user's", async () => {
  const f = await launch({
    user: { summaryModel: 'acme/mini' },
    project: { summaryModel: 'acme/large:high' },
  })
  await f.submit()
  await until(async () => (await f.read())?.assessmentStatus === 'ready')
  expect(f.requests()).toEqual([{ model: 'acme/large', reasoning: 'high' }])
})

it('applies a changed setting to the next request without a restart', async () => {
  const f = await launch({ user: { summaryModel: 'acme/mini' } })
  await f.submit()
  await until(async () => (await f.read())?.assessmentStatus === 'ready')
  f.settings.project = { summaryModel: 'acme/large' }
  await f.submit()
  await until(async () => (await f.assessed()).length === 2)
  expect(f.requests().map((request) => request.model)).toEqual(['acme/mini', 'acme/large'])
})

it.each([
  ['unavailable', 'acme/mini', []],
  ['unknown', 'acme/nothing', []],
  [
    'invalid',
    'not a model',
    [
      'Invalid summaryModel "not a model" in user settings: expected "provider/id[:thinking]"; summaries are off',
    ],
  ],
])('skips summaries quietly for an %s summary model', async (_case, summaryModel, notices) => {
  const f = await launch({
    user: { summaryModel },
    available: (model) => model.provider === 'openai-codex',
  })
  await f.submit()
  await until(async () => (await f.tasks()).length === 0)
  expect(f.requests()).toEqual([])
  expect((await f.read())?.assessmentStatus).toBeUndefined()
  expect(f.notices).toEqual(notices)
})

it('resumes an interrupted request with the model it chose, not a newer setting', async () => {
  const f = await launch({ user: { summaryModel: 'acme/mini' }, interrupt: 'model' })
  await f.submit()
  await until(f.interrupted)
  f.settings.project = { summaryModel: 'acme/large' }
  await f.reopen()
  await until(async () => (await f.assessed()).length === 1)
  expect(await f.assessed()).toMatchObject([{ model: 'acme/mini' }])
  expect(f.requests().every((request) => request.model === 'acme/mini')).toBe(true)
})

it('writes only the user summary model, and refuses while project settings decide it', async () => {
  const userHome = await temp('ultimate-summary-model-action-')
  const projectRoot = join(userHome, 'project')
  const path = join(userHome, '.ultimate/settings.json')
  await mkdir(join(userHome, '.ultimate'))
  await writeFile(
    path,
    JSON.stringify({ extensions: { enable: ['documents'] }, summaryModel: 'acme/mini' }),
  )
  const project: JsonObject = { summaryModel: 'acme/large' }
  const ctx = {
    host: { userHome, projectRoot, projectSettings: async () => project },
  } as unknown as ActionContext
  const projectFile = join(projectRoot, '.ultimate/settings.json')
  expect(await actions.summaryModel(null, ctx)).toEqual({
    value: 'acme/large',
    source: 'project',
    default: 'openai-codex/gpt-6-luna:low',
    path: projectFile,
  })
  for (const value of ['acme/mini:low', null])
    await expect(actions.setSummaryModel({ value }, ctx)).rejects.toThrow(
      `The summary model is set by project settings in ${projectFile}; edit that file to change it`,
    )
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
    extensions: { enable: ['documents'] },
    summaryModel: 'acme/mini',
  })
  delete project.summaryModel
  expect(await actions.summaryModel(null, ctx)).toEqual({
    value: 'acme/mini',
    source: 'user',
    default: 'openai-codex/gpt-6-luna:low',
  })
  expect(await actions.setSummaryModel({ value: 'acme/mini:low' }, ctx)).toMatchObject({
    value: 'acme/mini:low',
    source: 'user',
  })
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
    extensions: { enable: ['documents'] },
    summaryModel: 'acme/mini:low',
  })
  await expect(actions.setSummaryModel({ value: 'mini' }, ctx)).rejects.toThrow('provider/id')
  expect(await actions.setSummaryModel({ value: null }, ctx)).toMatchObject({ source: 'default' })
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
    extensions: { enable: ['documents'] },
  })
})

it.each([
  ['x-ai/grok-4.3:batch', { provider: 'x-ai', id: 'grok-4.3:batch', thinking: undefined }],
  ['x-ai/grok-4.3:batch:high', { provider: 'x-ai', id: 'grok-4.3:batch', thinking: 'high' }],
  ['acme/mini', { provider: 'acme', id: 'mini', thinking: undefined }],
  ['acme/mini:low', { provider: 'acme', id: 'mini', thinking: 'low' }],
  ['mini:high', undefined],
  ['acme/', undefined],
])('parses %s, stripping only a final thinking level', (value, expected) => {
  expect(parseSummaryModel(value)).toEqual(expected)
})

it('records the summary model on accepted intent and title entries', async () => {
  const f = await launch({ user: { summaryModel: 'acme/mini:low' }, established: false })
  await f.submit()
  await until(async () => (await f.read())?.assessmentStatus === 'ready')
  const entries = await f.entries()
  const intent = entries.filter((entry) => IntentSummarized.is(entry))
  const titles = entries.filter((entry) => TitleChanged.is(entry))
  expect(intent.map((entry) => entry.data)).toEqual([
    { summary: 'Implemented the change.', model: 'acme/mini', at: expect.any(Number) },
  ])
  expect(titles.map((entry) => entry.data)).toEqual([
    { title: 'Implement the change', model: 'acme/mini', at: expect.any(Number) },
  ])
  const task = await f.task(intent[0].byTaskId!)
  expect(task).toMatchObject({
    kind: 'conversations.summary',
    input: { intent: expect.any(Number) },
  })
  expect(titles[0].byTaskId).toBe(intent[0].byTaskId)
})

it('records an accepted spawn refresh behind a manual title, with its model', async () => {
  const f = await launch({ user: { summaryModel: 'acme/mini' } })
  await f.submit()
  await until(async () => (await f.read())?.assessmentStatus === 'ready')
  await f.rename('Manual title')
  f.settings.project = { summaryModel: 'acme/large' }
  await f.spawn()
  await until(async () => (await f.tasks()).length === 0)
  const entries = await f.entries()
  const refreshed = entries.filter((entry) => SpawnSummarized.is(entry))
  expect(refreshed.map((entry) => entry.data)).toEqual([
    { summary: 'Implemented the change.', model: 'acme/large', at: expect.any(Number) },
  ])
  expect(await f.task(refreshed[0].byTaskId!)).toMatchObject({
    kind: 'conversations.summary',
    input: { spawn: { agent: 'scout' } },
  })
  expect(entries.filter((entry) => TitleChanged.is(entry))).toHaveLength(1)
  expect(await f.title()).toBe('Manual title')
})

it('settles quietly when the summary model becomes unavailable before a resumed task chose one', async () => {
  const f = await launch({ user: { summaryModel: 'acme/mini' }, interrupt: 'generate' })
  await f.submit()
  await until(f.interrupted)
  f.settings.project = { summaryModel: 'acme/nothing' }
  await f.reopen()
  await until(async () => (await f.tasks()).length === 0)
  expect(f.requests()).toEqual([])
  const state = await f.read()
  expect(state?.pending).toBeUndefined()
  expect(state?.assessmentStatus).toBeUndefined()
  expect(state?.status).toBeUndefined()
  expect((await f.entries()).filter((entry) => SummaryDiscarded.is(entry))).toEqual([])
})
