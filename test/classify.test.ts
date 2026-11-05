import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { afterEach, expect, it, vi } from 'vitest'
import classify, { cooldownMs, secrets } from '../extensions/classify/server.ts'
import { ClassifyApi } from '../extensions/classify/api.ts'
import type { ClassifyService } from '../extensions/classify/api.ts'
import { writeSecret } from '../extensions/secrets/store.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import { removeTemp, temp } from './helpers.ts'

const cleanup: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  for (const root of cleanup.splice(0)) await removeTemp(root)
})

async function fixture(key = true, models?: unknown) {
  const root = await temp()
  cleanup.push(root)
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
  } as unknown as ExtensionHost)
  expect(extension.name).toBe('classify')
  expect(implement.mock.calls[0][0]).toBe(ClassifyApi)
  return { root, notice, service: implement.mock.calls[0][1] }
}

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

it('declares a valid secret for the Secrets panel', () => {
  expect(secrets).toEqual([
    {
      name: 'TYPESAFE_API_KEY',
      description: expect.any(String),
      url: 'https://console.typesafe.ai/keys',
      provider: 'typesafe',
    },
  ])
  expect(secrets[0].name).toMatch(/^[A-Z][A-Z0-9_]*$/)
  expect(secrets[0].description.length).toBeGreaterThan(0)
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
  const { service } = await fixture(true, {
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
  await expect(service.ask(request, signal)).rejects.toThrow('TypeSafe 402: billing_error')
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
