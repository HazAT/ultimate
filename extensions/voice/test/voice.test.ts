import { afterEach, expect, it, vi } from 'vitest'
import { actions, MAX_AUDIO_BYTES } from '../server.ts'
import { writeSecret } from '../../secrets/store.ts'
import type { ActionContext } from '../../../server/actions.ts'
import { removeTemp, temp } from '../../../test/helpers.ts'

const cleanup: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  for (const root of cleanup.splice(0)) await removeTemp(root)
})

const CHATGPT = 'https://chatgpt.com/backend-api/transcribe'
const API = 'https://api.openai.com/v1/audio/transcriptions'
const reason =
  'Voice needs a ChatGPT login or an OpenAI API key: sign in with ChatGPT, or add OPENAI_API_KEY in ⌘K → Secrets'

/**
 * A host holding what the arguments name: an `OPENAI_API_KEY` secret, an API key Pi's `openai` provider holds, and the
 * ChatGPT login's access token in Pi's `openai-codex` provider.
 */
async function context({
  secret,
  piKey,
  login,
}: { secret?: string; piKey?: string; login?: string } = {}) {
  const userHome = await temp()
  cleanup.push(userHome)
  if (secret) await writeSecret(userHome, 'OPENAI_API_KEY', secret)
  const modelRuntime = {
    getProviderAuthStatus: (provider: string) => ({
      configured: provider === 'openai-codex' ? login !== undefined : piKey !== undefined,
    }),
    isUsingOAuth: () => false,
    getAuth: async (provider: string) => {
      const token = provider === 'openai-codex' ? login : piKey
      return token ? { auth: { apiKey: token } } : undefined
    },
  }
  return {
    host: { userHome, modelRuntime },
    signal: new AbortController().signal,
  } as unknown as ActionContext
}

const audio = { audio: Buffer.from('fake audio').toString('base64'), mimeType: 'audio/mp4' }

it('transcribes with the ChatGPT login through ChatGPT’s own endpoint', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(Response.json({ text: ' Hello there. ' }))
  vi.stubGlobal('fetch', fetch)
  const ctx = await context({ login: 'token-sentinel' })
  expect(await actions.status(null, ctx)).toEqual({ available: true })
  expect(await actions.transcribe(audio, ctx)).toEqual({ text: 'Hello there.' })
  const [url, init] = fetch.mock.calls[0]
  expect(url).toBe(CHATGPT)
  expect(init?.headers).toEqual({ Authorization: 'Bearer token-sentinel' })
  const form = init?.body as FormData
  expect(form.get('model')).toBe('gpt-transcribe')
  expect(form.get('response_format')).toBeNull()
  const file = form.get('file') as File
  expect([file.name, file.type, await file.text()]).toEqual([
    'recording.mp4',
    'audio/mp4',
    'fake audio',
  ])
})

it('prefers the ChatGPT login over an API key, which costs credits', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ text: 'ok' }))
  vi.stubGlobal('fetch', fetch)
  const ctx = await context({ secret: 'sk-sentinel', piKey: 'sk-pi', login: 'token-sentinel' })
  await actions.transcribe(audio, ctx)
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([CHATGPT])
})

it('falls back to the API key when ChatGPT refuses the login', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'Rate limit reached' } }), { status: 429 }),
    )
    .mockResolvedValueOnce(Response.json({ text: ' from the key ' }))
  vi.stubGlobal('fetch', fetch)
  const ctx = await context({ secret: 'sk-sentinel', login: 'token-sentinel' })
  expect(await actions.transcribe(audio, ctx)).toEqual({ text: 'from the key' })
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([CHATGPT, API])
  expect(fetch.mock.calls[1][1]?.headers).toEqual({ Authorization: 'Bearer sk-sentinel' })
})

it('does not spend an API key on a failure that is not a refusal', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(new Response('<html>bad gateway</html>', { status: 502 }))
  vi.stubGlobal('fetch', fetch)
  const ctx = await context({ secret: 'sk-sentinel', login: 'token-sentinel' })
  await expect(actions.transcribe(audio, ctx)).rejects.toThrow(
    'Transcription through the ChatGPT login failed (HTTP 502)',
  )
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([CHATGPT])
})

it('names both credentials when both are refused', async () => {
  const error = (status: number, message: string) =>
    new Response(JSON.stringify({ error: { message } }), { status })
  vi.stubGlobal(
    'fetch',
    vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(error(429, 'Rate limit reached'))
      .mockResolvedValueOnce(error(429, 'You have no credits remaining')),
  )
  await expect(
    actions.transcribe(audio, await context({ secret: 'sk-sentinel', login: 'token-sentinel' })),
  ).rejects.toThrow(
    'ChatGPT is rate-limiting transcription (Rate limit reached): try again in a minute · OpenAI is rate-limiting transcription (You have no credits remaining): try again in a minute',
  )
})

it('names the recording after its type, including the browser’s codec parameter', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ text: 'ok' }))
  vi.stubGlobal('fetch', fetch)
  await actions.transcribe(
    { audio: audio.audio, mimeType: 'audio/webm;codecs=opus' },
    await context({ secret: 'sk-sentinel' }),
  )
  const [, init] = fetch.mock.calls[0]
  const form = init?.body as FormData
  const file = form.get('file') as File
  expect([file.name, file.type]).toEqual(['recording.webm', 'audio/webm;codecs=opus'])
})

it('posts the recording to OpenAI with the secret and returns the trimmed text', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(Response.json({ text: ' Hello there. ' }))
  vi.stubGlobal('fetch', fetch)
  expect(
    await actions.transcribe(audio, await context({ secret: 'sk-sentinel', piKey: 'sk-pi' })),
  ).toEqual({
    text: 'Hello there.',
  })
  const [url, init] = fetch.mock.calls[0]
  expect(url).toBe(API)
  expect(init?.headers).toEqual({ Authorization: 'Bearer sk-sentinel' })
  const form = init?.body as FormData
  expect(form.get('model')).toBe('gpt-4o-mini-transcribe')
  const file = form.get('file') as File
  expect([file.name, file.type, await file.text()]).toEqual([
    'recording.mp4',
    'audio/mp4',
    'fake audio',
  ])
})

it('falls back to an API key Pi holds for openai', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ text: 'ok' }))
  vi.stubGlobal('fetch', fetch)
  const ctx = await context({ piKey: 'sk-pi' })
  expect(await actions.status(null, ctx)).toEqual({ available: true })
  await actions.transcribe(audio, ctx)
  expect(fetch.mock.calls[0][1]?.headers).toEqual({ Authorization: 'Bearer sk-pi' })
})

it('without a credential: status disables voice and transcribe sends nothing', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>()
  vi.stubGlobal('fetch', fetch)
  const ctx = await context()
  expect(await actions.status(null, ctx)).toEqual({ available: false, reason })
  await expect(actions.transcribe(audio, ctx)).rejects.toThrow(reason)
  expect(fetch).not.toHaveBeenCalled()
})

it('asks for a new ChatGPT login when OpenAI refuses it', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({ error: { message: 'Could not parse your authentication token' } }),
        {
          status: 401,
        },
      ),
    ),
  )
  await expect(actions.transcribe(audio, await context({ login: 'stale' }))).rejects.toThrow(
    'OpenAI refused the ChatGPT login (Could not parse your authentication token): sign in with ChatGPT again',
  )
})

it('names a rate limit with OpenAI’s reason, and a rejected key', async () => {
  const error = (status: number, message: string) =>
    new Response(JSON.stringify({ error: { message } }), { status })
  vi.stubGlobal(
    'fetch',
    vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(error(429, 'Rate limit reached'))
      .mockResolvedValueOnce(error(401, 'Incorrect API key')),
  )
  const ctx = await context({ secret: 'sk-sentinel' })
  await expect(actions.transcribe(audio, ctx)).rejects.toThrow(
    'OpenAI is rate-limiting transcription (Rate limit reached): try again in a minute',
  )
  await expect(actions.transcribe(audio, ctx)).rejects.toThrow(
    'OpenAI rejected the API key: check OPENAI_API_KEY in ⌘K → Secrets',
  )
})

it('refuses a recording over the limit before calling OpenAI', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>()
  vi.stubGlobal('fetch', fetch)
  const big = Buffer.alloc(MAX_AUDIO_BYTES + 1).toString('base64')
  await expect(
    actions.transcribe(
      { audio: big, mimeType: 'audio/webm' },
      await context({ secret: 'sk-sentinel' }),
    ),
  ).rejects.toThrow('The recording is too large to transcribe')
  expect(fetch).not.toHaveBeenCalled()
})

it('reports a provider failure with its status, and an answer without text', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response('<html>bad gateway</html>', { status: 502 }))
      .mockResolvedValueOnce(Response.json({ nothing: true })),
  )
  const ctx = await context({ secret: 'sk-sentinel' })
  await expect(actions.transcribe(audio, ctx)).rejects.toThrow('Transcription failed (HTTP 502)')
  await expect(actions.transcribe(audio, ctx)).rejects.toThrow(
    'Transcription failed (HTTP 502): no text in the answer',
  )
})
