import { afterEach, expect, it, vi } from 'vitest'
import { actions } from '../server.ts'
import { plainSpeech, sections } from '../text.ts'
import type { ActionContext } from '../../../server/actions.ts'
import { removeTemp, temp } from '../../../test/helpers.ts'

const cleanup: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  for (const root of cleanup.splice(0)) await removeTemp(root)
})

async function context(rewrite: (input: string) => string) {
  const userHome = await temp()
  cleanup.push(userHome)
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

it('rewrites a section with the summary model and serves a replay from the cache', async () => {
  const { asked, ctx } = await context((input) => `Spoken: ${plainSpeech(input)}`)
  const first = await actions.prepare({ text: message, section: 0 }, ctx)
  expect(first).toEqual({
    sections: sections(message).length,
    spoken: `Spoken: ${plainSpeech(sections(message)[0])}`,
  })
  expect(await actions.prepare({ text: message, section: 0 }, ctx)).toEqual(first)
  expect(asked).toHaveLength(1)
})

it('reads the plain strip when the rewrite drops most of the text', async () => {
  const { ctx } = await context(() => 'A summary.')
  const result = await actions.prepare({ text: message, section: 0 }, ctx)
  expect(result.spoken).toBe(plainSpeech(sections(message)[0]))
})

it('strips what does not work heard and keeps every point', () => {
  expect(plainSpeech(message)).toBe(
    'Landed as. It changes only test config.\n\nFaster checks: e2e runs on 8 workers. No retry wait: a test skips the backoff.',
  )
})
