import { afterEach, expect, it, vi } from 'vitest'
import { actions } from '../server.ts'
import { plainSpeech, sections } from '../speech.ts'
import { writeSecret } from '../../secrets/store.ts'
import type { ActionContext } from '../../../server/actions.ts'
import { removeTemp, temp } from '../../../test/helpers.ts'

const cleanup: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  for (const root of cleanup.splice(0)) await removeTemp(root)
})

async function context(rewrite: (input: string) => string, key?: string) {
  const userHome = await temp()
  cleanup.push(userHome)
  if (key) await writeSecret(userHome, 'OPENAI_API_KEY', key)
  const asked: string[] = []
  const resources = new Map<string, unknown>()
  const conversations = {
    summaryModel: async () => ({ provider: 'p', id: 'm', thinking: 'low' }),
    askSummaryModel: async (_models: unknown, _system: string, input: string) => {
      asked.push(input)
      return { provider: 'p', model: 'm', text: rewrite(input), stopReason: 'stop' }
    },
  }
  const host = {
    userHome,
    modelRuntime: {
      getProviderAuthStatus: () => ({ configured: false }),
      isUsingOAuth: () => false,
      getProvider: () => ({ baseUrl: 'https://api.openai.com/v1' }),
      getAllModels: () => [{ baseUrl: 'https://api.openai.com/v1' }],
      getAuth: async () => undefined,
    },
    need: () => conversations,
    resource: <T>(name: string, create: () => T) => {
      if (!resources.has(name)) resources.set(name, create())
      return resources.get(name) as T
    },
  }
  return { asked, ctx: { host, signal: new AbortController().signal } as unknown as ActionContext }
}

const message =
  'Landed as `95a6f16` (#654228). It changes only test config.\n\n- **Faster checks:** e2e runs on 8 workers.\n- **No retry wait:** a test skips the backoff.'

it('rewrites a section with the summary model, voices it with OpenAI, and serves a replay from the cache', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(new Response(new Uint8Array([1, 2, 3])))
  vi.stubGlobal('fetch', fetch)
  const { asked, ctx } = await context((input) => `Spoken: ${plainSpeech(input)}`, 'sk-sentinel')
  const first = await actions.speak({ text: message, section: 0 }, ctx)
  expect(first).toEqual({
    sections: sections(message).length,
    spoken: `Spoken: ${plainSpeech(sections(message)[0])}`,
    audio: Buffer.from([1, 2, 3]).toString('base64'),
  })
  const [url, init] = fetch.mock.calls[0]
  expect(url).toBe('https://api.openai.com/v1/audio/speech')
  expect(JSON.parse(init?.body as string)).toMatchObject({
    model: 'gpt-4o-mini-tts',
    input: first.spoken,
  })
  expect(await actions.speak({ text: message, section: 0 }, ctx)).toEqual(first)
  expect([asked.length, fetch.mock.calls.length]).toEqual([1, 1])
})

it('reads the plain strip when the rewrite drops most of the text, and leaves speech to the browser without a key', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>()
  vi.stubGlobal('fetch', fetch)
  const { ctx } = await context(() => 'A summary.')
  const result = await actions.speak({ text: message, section: 0 }, ctx)
  expect(result.audio).toBeNull()
  expect(result.spoken).toBe(plainSpeech(sections(message)[0]))
  expect(fetch).not.toHaveBeenCalled()
})

it('strips what does not work heard and keeps every point', () => {
  expect(plainSpeech(message)).toBe(
    'Landed as. It changes only test config.\n\nFaster checks: e2e runs on 8 workers. No retry wait: a test skips the backoff.',
  )
})
