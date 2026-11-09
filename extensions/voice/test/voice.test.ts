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

/** A host whose secret store holds `key`, and whose Pi `openai` provider holds `piKey` as an API key when given. */
async function context(key?: string, piKey?: string) {
  const userHome = await temp()
  cleanup.push(userHome)
  if (key) await writeSecret(userHome, 'OPENAI_API_KEY', key)
  const modelRuntime = {
    getProviderAuthStatus: () => ({ configured: piKey !== undefined }),
    isUsingOAuth: () => false,
    getAuth: async () => (piKey ? { auth: { apiKey: piKey } } : undefined),
  }
  return {
    host: { userHome, modelRuntime },
    signal: new AbortController().signal,
  } as unknown as ActionContext
}

const audio = { audio: Buffer.from('fake audio').toString('base64'), mimeType: 'audio/mp4' }

it('posts the recording to OpenAI with the secret and returns the trimmed text', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(Response.json({ text: ' Hello there. ' }))
  vi.stubGlobal('fetch', fetch)
  expect(await actions.transcribe(audio, await context('sk-sentinel', 'sk-pi'))).toEqual({
    text: 'Hello there.',
  })
  const [url, init] = fetch.mock.calls[0]
  expect(url).toBe('https://api.openai.com/v1/audio/transcriptions')
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
  const ctx = await context(undefined, 'sk-pi')
  expect(await actions.status(null, ctx)).toEqual({ available: true })
  await actions.transcribe(audio, ctx)
  expect(fetch.mock.calls[0][1]?.headers).toEqual({ Authorization: 'Bearer sk-pi' })
})

it('without a key: status disables voice and transcribe sends nothing', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>()
  vi.stubGlobal('fetch', fetch)
  const ctx = await context()
  const reason = 'Voice needs an OpenAI API key: add OPENAI_API_KEY in ⌘K → Secrets'
  expect(await actions.status(null, ctx)).toEqual({ available: false, reason })
  await expect(actions.transcribe(audio, ctx)).rejects.toThrow(reason)
  expect(fetch).not.toHaveBeenCalled()
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
  const ctx = await context('sk-sentinel')
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
    actions.transcribe({ audio: big, mimeType: 'audio/webm' }, await context('sk-sentinel')),
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
  const ctx = await context('sk-sentinel')
  await expect(actions.transcribe(audio, ctx)).rejects.toThrow('Transcription failed (HTTP 502)')
  await expect(actions.transcribe(audio, ctx)).rejects.toThrow(
    'Transcription failed (HTTP 502): no text in the answer',
  )
})
