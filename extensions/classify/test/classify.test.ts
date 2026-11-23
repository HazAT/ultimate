import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import { InlineCodemodeSandbox, loadQuickJSWasm } from '@earendil-works/pi-codemode'
import {
  createRegistry,
  Harness,
  hook,
  ToolTask,
  MemoryStorage,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import { defineDoc } from '@earendil-works/pi-durable'
import type { JsonObject, Storage } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { createCodemodeExtension } from '@earendil-works/pi-durable/codemode'
import { modelCallLimits } from '../../codemode/models.ts'
import { afterEach, expect, it, vi } from 'vitest'
import classify, { cooldownMs, retryHeaders } from '../server.ts'
import { ClassifyApi } from '../api.ts'
import type { ClassifyService } from '../api.ts'
import { writeSecret } from '../../secrets/store.ts'
import type { ExtensionHost } from '../../../server/extensions.ts'
import { context } from '../../../server/harness.ts'
import { removeTemp, temp } from '../../../test/helpers.ts'

const cleanup: string[] = []
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  for (const root of cleanup.splice(0)) await removeTemp(root)
})

async function fixture(
  key = true,
  models?: unknown,
  harness?: () => Harness,
  storage: () => Promise<Storage> = async () => new MemoryStorage(),
) {
  const root = await temp()
  cleanup.push(root)
  let own: Harness | undefined
  const opened = harness ?? (() => own!)
  if (key) await writeSecret(root, 'TYPESAFE_API_KEY', 'test-sentinel')
  vi.stubEnv('TYPESAFE_API_KEY', undefined)
  const modelsPath = join(root, 'models.json')
  if (models) await writeFile(modelsPath, JSON.stringify(models))
  const modelRuntime = await ModelRuntime.create({
    modelsPath: models ? modelsPath : null,
    authPath: join(root, 'auth.json'),
  })
  const implement = vi.fn<(api: typeof ClassifyApi, service: ClassifyService) => void>()
  const notice = vi.fn<(message: string) => void>()
  const extension = classify({
    userHome: root,
    implement,
    modelRuntime,
    notice,
    harness: opened,
    onOpen: (callback: () => Promise<void>) => openers.push(callback),
    onClose: (callback: () => Promise<void>) => cleanups.push(callback),
  } as unknown as ExtensionHost)
  if (!harness) {
    own = await Harness.open(
      await storage(),
      { models: modelRuntime, registry: createRegistry() },
      context,
    )
    await own.root(context)
    const closing = own
    cleanups.push(() => closing.close(context))
    for (const open of openers.splice(0)) await open()
  }
  expect(extension.name).toBe('classify')
  expect(implement.mock.calls[0][0]).toBe(ClassifyApi)
  return {
    root,
    notice,
    service: implement.mock.calls[0][1],
    extension,
    modelRuntime,
    openers,
  }
}
const openers: (() => Promise<void>)[] = []

const request = {
  state: { message: 'Tests passed' },
  questions: {
    phase: {
      type: 'choice' as const,
      instructions: { question: 'What phase?' },
      criteria: { verifying: 'Running tests', editing: null },
    },
    passed: { type: 'noul' as const, instructions: 'Did tests pass?' },
    quality: {
      type: 'score' as const,
      instructions: 'How good?',
      criteria: ['Bad', { good: true }],
    },
  },
}
const answers = {
  phase: { type: 'choice', choice: 'verifying', confidence: 0.9, probabilities: { verifying: 1 } },
  passed: { type: 'noul', noul: 0.99 },
  quality: {
    type: 'score',
    score: 1,
    confidence: 1,
    probabilities: { '0': 0, '1': 1 },
    legend: { '0': 'Bad', '1': { good: true } },
  },
}
const body = { model: 'jev-1.14.0', answers, usage: { input_tokens: 123, output_tokens: 18 } }
const scriptCall = `models.classify({provider: 'typesafe', id: 'jev-1.14.0'}, {
  state: {message: 'Tests passed'},
  questions: {phase: {type: 'choice', instructions: 'Which phase?', criteria: {verifying: 'Running tests', editing: 'Making changes'}}}
})`

async function codemodeFixture() {
  const registry = createRegistry()
  let harness: Harness
  const f = await fixture(true, undefined, () => harness)
  const faux = fauxProvider()
  f.modelRuntime.registerNativeProvider(faux.provider)
  const sandbox = new InlineCodemodeSandbox({ wasm: loadQuickJSWasm() })
  const codemode = createCodemodeExtension({ sandbox, models: true })
  const nestedResults: string[] = []
  registry.install({
    ...codemode,
    hooks: [
      modelCallLimits(() => harness),
      hook(ToolTask, {
        afterTool: (call, result) => {
          if (call.parent) nestedResults.push(JSON.stringify(result))
          return undefined
        },
      }),
    ],
  })
  registry.install(f.extension)
  harness = await Harness.open(new MemoryStorage(), { models: f.modelRuntime, registry }, context)
  for (const open of openers.splice(0)) await open()
  cleanups.push(async () => {
    await harness.close(context)
    await sandbox.close()
  })
  const root = await harness.root(context, {
    agent: { model: { provider: 'faux', modelId: 'faux-1' } },
  })
  harness.resume()
  return {
    ...f,
    nestedResults,
    run: async (code: string) => {
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall('codemode', { code }), { stopReason: 'toolUse' }),
        fauxAssistantMessage('Done'),
      ])
      const submission = await root.submit({ type: 'input', content: 'Run the script' }, context)
      await submission.wait(context)
      const found = (await root.entries({ order: 'descending' }, 10, undefined, context)).items
        .flatMap((entry) => entry.model ?? [])
        .find((message) => message.role === 'toolResult' && message.toolName === 'codemode')
      if (found?.role !== 'toolResult') throw new Error('Missing codemode result')
      return found.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n')
    },
  }
}

it('shares a codemode 402 with the service and bills only the completed requests', async () => {
  const { run, service, notice, root, modelRuntime } = await codemodeFixture()
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(new Response('billing_error', { status: 402 }))
    .mockImplementation(async () => Response.json(body))
  vi.stubGlobal('fetch', fetch)
  expect(
    (await modelRuntime.getAvailableOfType('classifier', 'typesafe')).map((m) => m.id),
  ).toEqual(['jev-latest', 'jev-1.14.0'])
  const paused = await run(`text((await ${scriptCall}).errorMessage); await ${scriptCall};`)
  expect(paused).toContain('System One API error (402): {"error":"TypeSafe 402: out of credits"}')
  expect(paused).toContain('Tool call blocked: TypeSafe 402: out of credits')
  expect(paused).toContain('models: 1 call, 0 input tokens, ≈$0')
  await expect(service.ask(request, new AbortController().signal)).rejects.toThrow(
    'TypeSafe 402: out of credits',
  )
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(notice).toHaveBeenCalledExactlyOnceWith(
    'TypeSafe: out of credits; classification paused for 15 minutes',
  )
  await writeSecret(root, 'TYPESAFE_API_KEY', 'updated-sentinel')
  const resumed = await run(`text((await ${scriptCall}).answers.phase.choice);`)
  expect(resumed).toContain('verifying')
  expect(resumed).toContain('models: 1 call, 123 input tokens, ≈$0.00000517')
  expect(new Headers(fetch.mock.calls[1][1]?.headers).get('Authorization')).toBe(
    'Bearer updated-sentinel',
  )
})

it('blocks call 1001 of a codemode script', async () => {
  const { run } = await codemodeFixture()
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => Response.json(body))
  vi.stubGlobal('fetch', fetch)
  const result = await run(`for (let i = 0; i < 1001; i++) await ${scriptCall};`)
  expect(result).toContain('models: at most 1000 classify/generateImages calls per script')
  expect(result).toContain('models: 1000 calls, 123k input tokens, ≈$0.00517')
  expect(fetch).toHaveBeenCalledTimes(1000)
})

it('sends the pinned model, JSON questions, stored key and abort signal; parses all answer types', async () => {
  const { service, root } = await fixture()
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => Response.json(body))
  vi.stubGlobal('fetch', fetch)
  const signal = new AbortController().signal
  expect(await service.ask(request, signal)).toEqual({
    model: 'jev-1.14.0',
    answers,
    usage: { inputTokens: 123 },
  })
  expect(fetch).toHaveBeenCalledWith('https://api.typesafe.ai/v1/systemone', {
    method: 'POST',
    headers: { Authorization: 'Bearer test-sentinel', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'jev-1.14.0', ...request }),
    signal,
  })
  await writeSecret(root, 'TYPESAFE_API_KEY', 'updated-sentinel')
  await service.ask(request, signal)
  expect(fetch.mock.calls[1][1]?.headers).toEqual({
    Authorization: 'Bearer updated-sentinel',
    'Content-Type': 'application/json',
  })
})

it("sends to the endpoint and key of Pi's configured typesafe provider over the stored secret", async () => {
  vi.stubEnv('EXAMPLE_PROXY_KEY', 'proxy-sentinel')
  const { service, modelRuntime } = await fixture(true, {
    providers: {
      typesafe: { baseUrl: 'https://proxy.example.com/typesafe/v1', apiKey: '$EXAMPLE_PROXY_KEY' },
    },
  })
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => Response.json(body))
  vi.stubGlobal('fetch', fetch)
  await service.ask(request, new AbortController().signal)
  expect(fetch.mock.calls[0][0]).toBe('https://proxy.example.com/typesafe/v1/systemone')
  expect(fetch.mock.calls[0][1]?.headers).toEqual({
    Authorization: 'Bearer proxy-sentinel',
    'Content-Type': 'application/json',
  })
  const model = modelRuntime.getModelOfType('classifier', 'typesafe', 'jev-1.14.0')!
  const result = await modelRuntime.classify(model, {
    state: request.state,
    questions: {
      phase: {
        type: 'choice',
        instructions: 'What phase?',
        criteria: { verifying: 'Running tests' },
      },
    },
  })
  expect(result.answers.phase).toEqual(answers.phase)
  expect(fetch.mock.calls[1][0]).toEqual(new URL('https://proxy.example.com/typesafe/v1/systemone'))
  expect(new Headers(fetch.mock.calls[1][1]?.headers).get('Authorization')).toBe(
    'Bearer proxy-sentinel',
  )
})

it('names the missing key and Secrets panel without sending a request', async () => {
  const { service } = await fixture(false)
  const fetch = vi.fn<typeof globalThis.fetch>()
  vi.stubGlobal('fetch', fetch)
  await expect(service.ask(request, new AbortController().signal)).rejects.toThrow(
    /TYPESAFE_API_KEY.*Secrets panel/,
  )
  expect(fetch).not.toHaveBeenCalled()
})

it('includes the HTTP status and truncated response body without retrying', async () => {
  const { service } = await fixture()
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(new Response('x'.repeat(2000), { status: 429 }))
  vi.stubGlobal('fetch', fetch)
  await expect(service.ask(request, new AbortController().signal)).rejects.toThrow(
    `TypeSafe 429: ${'x'.repeat(1000)}`,
  )
  expect(fetch).toHaveBeenCalledTimes(1)
})

it('stops sending after a 402 until the cooldown ends', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const { service, notice } = await fixture()
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(new Response('billing_error', { status: 402 }))
    .mockImplementation(async () => Response.json(body))
  vi.stubGlobal('fetch', fetch)
  const signal = new AbortController().signal
  await expect(service.ask(request, signal)).rejects.toThrow('TypeSafe 402: billing_error')
  await expect(service.ask(request, signal)).rejects.toThrow('TypeSafe 402: out of credits')
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(notice).toHaveBeenCalledWith(expect.stringContaining('TypeSafe: out of credits'))
  vi.advanceTimersByTime(cooldownMs)
  expect((await service.ask(request, signal)).model).toBe('jev-1.14.0')
  expect(fetch).toHaveBeenCalledTimes(2)
})

it.each([
  null,
  { ...body, usage: {} },
  { ...body, answers: {} },
  { ...body, answers: { ...answers, phase: { type: 'noul', noul: 1 } } },
])('rejects malformed envelopes and missing or mismatched answers (%j)', async (malformed) => {
  const { service } = await fixture()
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(malformed)),
  )
  await expect(service.ask(request, new AbortController().signal)).rejects.toThrow(
    'Malformed TypeSafe response',
  )
})

it('names the pinned Jev model in the prompt only for agents with codemode', async () => {
  const { extension } = await fixture()
  const section = extension.sections![0]
  const render = (names: string[]) =>
    section.render(
      { agent: { tools: names.map((name) => ({ name })) } } as unknown as Parameters<
        typeof section.render
      >[0],
      context,
    )
  expect(await render(['codemode'])).toContain("id: 'jev-1.14.0'")
  expect(await render(['read'])).toBeUndefined()
})

it('keeps a 402 pause across a restart, storing only a key fingerprint and the status', async () => {
  const dir = await temp()
  cleanup.push(dir)
  const file = join(dir, 'state.sqlite')
  const sqlite = () => openNodeSqliteStorage(file)
  const first = await fixture(true, undefined, undefined, sqlite)
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(new Response('rejected key echo-sentinel', { status: 402 }))
    .mockImplementation(async () => Response.json(body))
  vi.stubGlobal('fetch', fetch)
  const signal = new AbortController().signal
  await expect(first.service.ask(request, signal)).rejects.toThrow('echo-sentinel')
  for (const close of cleanups.splice(0).toReversed()) await close()
  const second = await fixture(true, undefined, undefined, sqlite)
  await expect(second.service.ask(request, signal)).rejects.toThrow('TypeSafe 402')
  expect(fetch).toHaveBeenCalledTimes(1)
  for (const close of cleanups.splice(0).toReversed()) await close()
  const reopened = await Harness.open(
    await sqlite(),
    { models: second.modelRuntime, registry: createRegistry() },
    context,
  )
  cleanups.push(() => reopened.close(context))
  const stored = JSON.stringify(
    await reopened.snapshot(
      defineDoc<JsonObject>({
        kind: 'classify.pause',
        scope: 'conversation',
        version: 1,
        history: 'latest',
        fork: 'initial',
        initial: () => ({}),
        checkpointWhen: () => false,
      }),
      ROOT_CONVERSATION_ID,
      context,
    ),
  )
  expect(stored).toMatch(/"keyId":"[0-9a-f]{16}"/)
  expect(stored).toMatch(/"status":402/)
  expect(stored).not.toContain('test-sentinel')
  expect(stored).not.toContain('echo-sentinel')
})

it.each([
  [402, 'TypeSafe 402: out of credits'],
  [400, 'TypeSafe 400'],
])('keeps an echoed %i body out of the script and its nested results', async (status, shown) => {
  const { run, nestedResults } = await codemodeFixture()
  vi.stubGlobal(
    'fetch',
    vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        new Response('bad key echo-sentinel', { status, statusText: 'status-sentinel' }),
      ),
  )
  const output = await run(`text((await ${scriptCall}).errorMessage)`)
  expect(output).toContain(shown)
  expect(nestedResults.length).toBeGreaterThan(0)
  expect(JSON.stringify([output, nestedResults])).not.toContain('echo-sentinel')
  expect(JSON.stringify([output, nestedResults])).not.toContain('status-sentinel')
})

it('passes only valid retry headers on to Pi with the fixed error body', () => {
  expect(
    retryHeaders(
      new Headers({
        'retry-after': '7',
        'retry-after-ms': 'header-sentinel',
        'x-should-retry': 'true',
        'x-echo': 'header-sentinel',
      }),
    ),
  ).toEqual({ 'retry-after': '7', 'x-should-retry': 'true' })
  expect(
    retryHeaders(
      new Headers({ 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT', 'retry-after-ms': '1500' }),
    ),
  ).toEqual({ 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT', 'retry-after-ms': '1500' })
  expect(retryHeaders(new Headers({ 'retry-after': '2026 header-sentinel' }))).toEqual({})
})

it('keeps a 429 retry-after for Pi and drops other upstream headers', async () => {
  const { run, nestedResults } = await codemodeFixture()
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    new Response('busy', {
      status: 429,
      headers: { 'retry-after': '0', 'x-echo': 'header-sentinel' },
    }),
  )
  vi.stubGlobal('fetch', fetch)
  const output = await run(`text((await ${scriptCall}).errorMessage)`)
  expect(output).toContain('TypeSafe 429: request failed')
  expect(JSON.stringify([output, nestedResults])).not.toContain('header-sentinel')
})
