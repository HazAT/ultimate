import { mkdir, writeFile } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import type { JsonObject } from '@earendil-works/pi-durable'
import * as command from '../../../lib/speech.ts'
import { wavOf } from '../../../lib/speech.ts'
import speech from '../server.ts'
import { SpeechApi, SpeechEngine } from '../api.ts'
import type { SpeechEngineService, SpeechService } from '../api.ts'
import type { ExtensionHost } from '../../../server/extensions.ts'
import { removeTemp, temp } from '../../../test/helpers.ts'

const pcm = Buffer.from([0, 0, 255, 127])
const wav = { audio: wavOf(pcm).toString('base64'), mimeType: 'audio/wav' }
const narrator = { model: 'gpt-realtime-2.1-mini', voice: 'marin', instructions: 'Read it.' }
const reader = { model: 'gpt-4o-mini-tts', voice: 'marin', instructions: 'Calm.' }

const cleanup: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  for (const root of cleanup.splice(0)) await removeTemp(root)
})

async function fixture(user: JsonObject = {}, engine?: SpeechEngineService) {
  const home = await temp('speech-')
  cleanup.push(home)
  await mkdir(`${home}/.ultimate`)
  await writeFile(`${home}/.ultimate/settings.json`, JSON.stringify({ speech: user }))
  const project: JsonObject = {}
  const getAuth = vi.fn<() => Promise<{ auth: { apiKey: string } }>>(async () => ({
    auth: { apiKey: 'test-key' },
  }))
  const resources = new Map<string, unknown>()
  let service!: SpeechService
  speech({
    userHome: home,
    projectSettings: async () => ({ speech: project }),
    modelRuntime: {
      getProviderAuthStatus: () => ({ configured: true }),
      isUsingOAuth: () => false,
      getAuth,
    },
    want: (api: unknown) => (api === SpeechEngine ? engine : undefined),
    implement: (api: unknown, value: SpeechService) => {
      if (api === SpeechApi) service = value
    },
    resource: <T>(name: string, create: () => T) => {
      if (!resources.has(name)) resources.set(name, create())
      return resources.get(name) as T
    },
  } as unknown as ExtensionHost)
  const speak = (text: string, openai = narrator) =>
    service.speak({ text, openai, timeoutMs: 20_000 }, new AbortController().signal)
  return { speak, service: () => service, project, getAuth }
}

function realtime() {
  const connect = vi.fn<(url: string) => EventTarget>(function () {
    const socket = new EventTarget()
    Object.assign(socket, {
      close: () => socket.dispatchEvent(new Event('close')),
      send: (data: string) => {
        if (JSON.parse(data).type !== 'response.create') return
        for (const event of [
          { type: 'response.output_audio.delta', delta: pcm.toString('base64') },
          { type: 'response.done' },
        ])
          socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(event) }))
      },
    })
    queueMicrotask(() => socket.dispatchEvent(new Event('open')))
    return socket
  })
  vi.stubGlobal('WebSocket', connect)
  return connect
}

function speechEndpoint() {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(async () => new Response(new Uint8Array([1, 2, 3])))
  vi.stubGlobal('fetch', fetch)
  return fetch
}

it('speaks with OpenAI by default, each caller on its own model, and replays from the cache', async () => {
  const { speak } = await fixture()
  const connect = realtime()
  const fetch = speechEndpoint()
  expect(await speak('A narrator line.')).toEqual(wav)
  expect(connect.mock.calls[0][0]).toBe(
    'wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1-mini',
  )
  expect(await speak('A section.', reader)).toEqual({ audio: 'AQID', mimeType: 'audio/mpeg' })
  const [url, init] = fetch.mock.calls[0]
  expect(url).toBe('https://api.openai.com/v1/audio/speech')
  expect(JSON.parse(init?.body as string)).toEqual({
    model: 'gpt-4o-mini-tts',
    voice: 'marin',
    input: 'A section.',
    instructions: 'Calm.',
    response_format: 'mp3',
  })
  expect(init?.headers).toMatchObject({ Authorization: 'Bearer test-key' })
  await speak('A narrator line.')
  await speak('A section.', reader)
  expect([connect.mock.calls.length, fetch.mock.calls.length]).toEqual([1, 1])
})

it('speaks every caller with the command, never OpenAI, and caches by command and text', async () => {
  const { speak, project, getAuth } = await fixture({ voice: 'command', command: ['voice', 'one'] })
  const render = vi
    .spyOn(command, 'speakCommand')
    .mockResolvedValue({ audio: wavOf(pcm), mimeType: 'audio/wav' })
  const connect = realtime()
  const fetch = speechEndpoint()
  expect(await speak('A line.')).toEqual(wav)
  expect(await speak('A line.', reader)).toEqual(wav)
  expect(render).toHaveBeenCalledExactlyOnceWith(
    ['voice', 'one'],
    'A line.',
    expect.any(AbortSignal),
  )
  project.command = ['voice', 'two']
  await speak('A line.')
  expect(render).toHaveBeenLastCalledWith(['voice', 'two'], 'A line.', expect.any(AbortSignal))
  expect(getAuth).not.toHaveBeenCalled()
  expect(connect).not.toHaveBeenCalled()
  expect(fetch).not.toHaveBeenCalled()
})

it('leaves a failed or missing local engine to the browser, not OpenAI, and tries again next time', async () => {
  const { speak, project, getAuth } = await fixture({ voice: 'command', command: ['voice'] })
  const render = vi.spyOn(command, 'speakCommand').mockRejectedValue(new Error('No model'))
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const connect = realtime()
  expect(await speak('A line.')).toBeNull()
  expect(warning).toHaveBeenCalledWith(
    'Speech failed, leaving it to the browser',
    expect.any(Error),
  )
  render.mockResolvedValue({ audio: wavOf(pcm), mimeType: 'audio/wav' })
  expect(await speak('A line.')).toEqual(wav)
  project.command = []
  expect(await speak('Another line.')).toBeNull()
  project.voice = 'kokoro'
  expect(await speak('Another line.')).toBeNull()
  project.voice = 'off'
  expect(await speak('A line.')).toBeNull()
  expect(render).toHaveBeenCalledTimes(2)
  expect(getAuth).not.toHaveBeenCalled()
  expect(connect).not.toHaveBeenCalled()
})

it('speaks with the engine another extension provides when speech.voice names it, within the deadline and only while it is provided', async () => {
  const engine = { id: 'kokoro', speak: vi.fn<SpeechEngineService['speak']>(async () => wav) }
  const { speak, service, getAuth } = await fixture({ voice: 'kokoro' }, engine)
  expect(await speak('A line.')).toEqual(wav)
  expect(engine.speak).toHaveBeenCalledExactlyOnceWith('A line.', expect.any(AbortSignal))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  engine.speak.mockImplementation(() => new Promise(() => {}))
  const request = { text: 'A slow line.', openai: narrator, timeoutMs: 10 }
  expect(await service().speak(request, new AbortController().signal)).toBeNull()
  engine.id = 'another'
  expect(await speak('A line.')).toBeNull()
  expect(getAuth).not.toHaveBeenCalled()
})
