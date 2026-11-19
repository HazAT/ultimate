import { CodemodeSandbox } from '@earendil-works/pi-codemode'
import type {
  AnyModel,
  ClassifierContext,
  ClassifierResult,
  Models,
  ModelType,
  Usage,
} from '@earendil-works/pi-ai'
import { afterEach, expect, it } from 'vitest'
import { until } from '../../../test/helpers.ts'
import { MAX_CONCURRENT_MODEL_CALLS, modelGlobals, modelsAvailable } from '../models.ts'

const judge = {
  type: 'classifier',
  provider: 'acme',
  id: 'judge',
  api: 'typesafe-system-one',
  baseUrl: 'https://classifier.example.com',
  headers: { authorization: 'Bearer secret-token' },
} as unknown as AnyModel
const painter = { ...judge, type: 'image', id: 'painter', api: 'openai-images' } as AnyModel
const catalog = [judge, painter]

const usage = (tokens: number, cost: number): Usage => ({
  input: tokens,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: tokens,
  cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
})
const question = {
  match: { type: 'bool', instructions: 'Is it relevant?', criteria: { true: 'yes', false: 'no' } },
}

type Classify = (
  model: AnyModel,
  context: ClassifierContext,
  options: { signal: AbortSignal },
) => Promise<ClassifierResult>

function fakeModels(classify: Classify) {
  return {
    getModelsOfType: (type: ModelType) => catalog.filter((model) => model.type === type),
    getAvailableOfType: async (type: ModelType) => catalog.filter((model) => model.type === type),
    getModelOfType: (type: ModelType, provider: string, id: string) =>
      catalog.find(
        (model) => model.type === type && model.provider === provider && model.id === id,
      ),
    classify,
    generateImages: async (model: AnyModel) => ({
      api: model.api,
      provider: model.provider,
      model: model.id,
      output: [{ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }],
      usage: usage(5, 0.005),
      stopReason: 'stop',
      timestamp: 0,
    }),
  } as unknown as Models
}

const answered = (model: AnyModel, tokens = 3): ClassifierResult => ({
  api: 'typesafe-system-one',
  provider: model.provider,
  model: model.id,
  answers: { match: { type: 'bool', probability: 0.9 } },
  usage: usage(tokens, tokens / 1000),
  stopReason: 'stop',
  timestamp: 0,
})

const sandboxes: CodemodeSandbox[] = []
afterEach(async () => {
  for (const sandbox of sandboxes.splice(0)) await sandbox.close()
})

function script(models: Models) {
  const calls: { name: string; args: unknown[]; status: string }[] = []
  const spent: Usage[] = []
  const sandbox = new CodemodeSandbox({
    tools: [],
    globals: modelGlobals(
      models,
      (name, args) => {
        const call = { name, args, status: 'running' }
        calls.push(call)
        return (status) => {
          call.status = status
        }
      },
      (spent_) => spent.push(spent_),
    ),
    timeoutMs: 10_000,
  })
  sandboxes.push(sandbox)
  return {
    calls,
    spent,
    run: (code: string, signal = new AbortController().signal) =>
      sandbox.execute(code, { signal, store: {} }),
  }
}

it('lists the catalog without provider headers', async () => {
  const { run, calls } = script(fakeModels(async (model) => answered(model)))
  const result = await run(`return {
    all: await models.getModelsOfType('classifier'),
    available: await models.getAvailableOfType('image', 'acme'),
    one: await models.getModelOfType('classifier', 'acme', 'judge'),
    missing: await models.getModelOfType('classifier', 'acme', 'nope'),
  }`)
  expect(result.ok).toBe(true)
  const value = (result as { value: Record<string, unknown> }).value
  expect(JSON.stringify(value)).not.toContain('secret-token')
  expect(value).toEqual({
    all: [expect.objectContaining({ provider: 'acme', id: 'judge' })],
    available: [expect.objectContaining({ id: 'painter' })],
    one: expect.objectContaining({ baseUrl: 'https://classifier.example.com' }),
  })
  expect(value.one).not.toHaveProperty('headers')
  expect(calls.map((call) => call.name)).toEqual([
    'models.getModelsOfType',
    'models.getAvailableOfType',
    'models.getModelOfType',
    'models.getModelOfType',
  ])
  const wrong = await run(`return await models.getModelOfType('classifier', 'acme/judge')`)
  expect(wrong.ok || wrong.error.message).toContain('expects three strings')
})

it('classifies with the catalog model, logs only the model, and reports usage', async () => {
  const received: { model: AnyModel; context: ClassifierContext; signal: AbortSignal }[] = []
  const { run, calls, spent } = script(
    fakeModels(async (model, context, { signal }) => {
      received.push({ model, context, signal })
      return answered(model)
    }),
  )
  const result = await run(`
    const jev = await models.getModelOfType('classifier', 'acme', 'judge');
    const res = await models.classify({ ...jev, baseUrl: 'https://attacker.example.com' },
      { state: { goal: 'private goal' }, questions: ${JSON.stringify(question)} });
    return { stopReason: res.stopReason, probability: res.answers.match.probability }`)
  expect(result.ok && result.value).toEqual({ stopReason: 'stop', probability: 0.9 })
  expect(received[0].model).toBe(judge)
  expect(received[0].context.state).toEqual({ goal: 'private goal' })
  expect(received[0].signal).toBeInstanceOf(AbortSignal)
  expect(calls[1]).toEqual({ name: 'models.classify', args: ['acme/judge'], status: 'ok' })
  expect(JSON.stringify(calls)).not.toContain('private goal')
  expect(spent).toEqual([usage(3, 0.003)])
  const failures = await run(`
    const messages = [];
    for (const call of [
      () => models.classify(undefined, {}),
      () => models.classify({ provider: 'acme', id: 'painter' }, {}),
      () => models.classify({ provider: 'acme', id: 'judge' }, { state: {}, questions: { q: { type: 'bool', instructions: 'x', criteria: ['a'] } } }),
    ]) try { await call() } catch (error) { messages.push(error.message) }
    return messages`)
  expect(failures.ok && failures.value).toEqual([
    expect.stringContaining('returns undefined for an unknown provider or id'),
    expect.stringContaining('"acme/painter" is an image model, not a classifier model'),
    expect.stringContaining(
      'is a "bool" question, so criteria must be { true: string, false: string }',
    ),
  ])
})

it(`runs at most ${MAX_CONCURRENT_MODEL_CALLS} model calls at once`, async () => {
  const pending: (() => void)[] = []
  let active = 0
  let most = 0
  const { run, spent, calls } = script(
    fakeModels(async (model) => {
      most = Math.max(most, ++active)
      await new Promise<void>((resolve) => pending.push(resolve))
      active--
      return answered(model, 1)
    }),
  )
  const done = run(`
    const jev = await models.getModelOfType('classifier', 'acme', 'judge');
    const all = await Promise.all(Array.from({ length: 6 }, (_, n) =>
      models.classify(jev, { state: { n }, questions: ${JSON.stringify(question)} })));
    return all.length`)
  await until(() => calls.filter((call) => call.name === 'models.classify').length === 6)
  expect(pending).toHaveLength(MAX_CONCURRENT_MODEL_CALLS)
  for (let released = 0; released < 6; released++) {
    await until(() => pending.length >= Math.min(MAX_CONCURRENT_MODEL_CALLS, 6 - released))
    pending.shift()!()
  }
  const result = await done
  expect(result.ok && result.value).toBe(6)
  expect(most).toBe(MAX_CONCURRENT_MODEL_CALLS)
  expect(spent).toHaveLength(6)
})

it('cancels running classify calls with the script and never starts queued ones', async () => {
  let started = 0
  const { run, calls } = script(
    fakeModels(async (model, _context, { signal }) => {
      started++
      if (!signal.aborted)
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
      return { ...answered(model), stopReason: 'aborted', usage: undefined }
    }),
  )
  const controller = new AbortController()
  const done = run(
    `const jev = await models.getModelOfType('classifier', 'acme', 'judge');
     await Promise.all(Array.from({ length: 6 }, () =>
       models.classify(jev, { state: {}, questions: ${JSON.stringify(question)} })));`,
    controller.signal,
  )
  const classified = () => calls.filter((call) => call.name === 'models.classify')
  await until(() => started === MAX_CONCURRENT_MODEL_CALLS && classified().length === 6)
  controller.abort()
  expect((await done).ok).toBe(false)
  await until(() => classified().every((call) => call.status !== 'running'))
  expect(classified().map((call) => call.status)).toEqual(Array(6).fill('cancelled'))
  expect(started).toBe(MAX_CONCURRENT_MODEL_CALLS)
})

it('generates images with the catalog image model and reports usage', async () => {
  const { run, calls, spent } = script(fakeModels(async (model) => answered(model)))
  const result = await run(`
    const painter = await models.getModelOfType('image', 'acme', 'painter');
    const res = await models.generateImages(painter, { input: [{ type: 'text', text: 'a private prompt' }] });
    let wrong; try { await models.generateImages(painter, { prompt: 'x' }) } catch (error) { wrong = error.message }
    return { stopReason: res.stopReason, blocks: res.output.length, wrong }`)
  expect(result.ok && result.value).toEqual({
    stopReason: 'stop',
    blocks: 1,
    wrong: expect.stringContaining('context.input must be a non-empty array of blocks'),
  })
  expect(calls[1]).toEqual({ name: 'models.generateImages', args: ['acme/painter'], status: 'ok' })
  expect(JSON.stringify(calls)).not.toContain('private prompt')
  expect(spent).toEqual([usage(5, 0.005)])
})

it('offers models only when a classifier or image provider has auth, checking no other provider', async () => {
  const checked: string[] = []
  const models = (available: AnyModel[]) =>
    ({
      getModelsOfType: (type: ModelType) => catalog.filter((model) => model.type === type),
      getAllAvailable: async (provider: string) => {
        checked.push(provider)
        if (provider !== 'acme') throw new Error(`${provider} auth check failed`)
        return available
      },
    }) as unknown as Models
  expect(await modelsAvailable(models([]))).toBe(false)
  expect(await modelsAvailable(models([painter]))).toBe(true)
  expect(checked).toEqual(['acme', 'acme'])
})
