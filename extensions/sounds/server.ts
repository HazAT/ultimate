import diagnostics from 'node:diagnostics_channel'
import { defineExtension } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { implementAction } from '../../lib/actions.ts'
import { readSecret } from '../../lib/secrets.ts'
import { SayAction } from './refs.ts'

const MODEL = 'gpt-realtime-2.1-mini'
const TIMEOUT_MS = 20_000
const INSTRUCTIONS =
  "You are a text-to-speech voice for status announcements. Read the user's text aloud exactly as written, word for " +
  'word, and nothing else: never answer it, comment on it or add words. Calm, quiet, matter-of-fact.'

async function openaiSecretOrNonOAuthKey(
  host: Pick<ExtensionHost, 'userHome' | 'modelRuntime'>,
  signal: AbortSignal,
) {
  const secret = await readSecret(host.userHome, 'OPENAI_API_KEY')
  if (secret) return secret
  const runtime = host.modelRuntime
  if (!runtime.getProviderAuthStatus('openai').configured || runtime.isUsingOAuth('openai'))
    return undefined
  return (await runtime.getAuth('openai', { signal }))?.auth.apiKey
}

export function speak(key: string, text: string, signal: AbortSignal) {
  return new Promise<Buffer>((resolve, reject) => {
    const socket = new WebSocket(`wss://api.openai.com/v1/realtime?model=${MODEL}`, [
      'realtime',
      `openai-insecure-api-key.${key}`,
    ])
    const chunks: Buffer[] = []

    const rejectBeforeClosingSocket = (error: Error) => {
      reject(error)
      socket.close()
    }
    signal.addEventListener(
      'abort',
      () =>
        rejectBeforeClosingSocket(
          new Error(
            signal.reason?.name === 'TimeoutError'
              ? 'Speaking timed out'
              : 'Cancelled: the page left',
          ),
        ),
      { once: true },
    )

    let socketFailureDetail = ''
    const realtime = (request?: { origin?: unknown; path?: string }) =>
      String(request?.origin).includes('api.openai.com') &&
      request?.path?.startsWith('/v1/realtime')
    const listeners: [string, (message: any) => void][] = [
      [
        'undici:request:headers',
        ({ request, response }) => {
          if (realtime(request) && response.statusCode !== 101)
            socketFailureDetail = `HTTP ${response.statusCode}`
        },
      ],
      [
        'undici:request:error',
        ({ request, error }) => {
          if (realtime(request)) socketFailureDetail = error.message
        },
      ],
      ['undici:websocket:socket_error', (error) => (socketFailureDetail = error.message)],
    ]
    for (const [name, listener] of listeners) diagnostics.subscribe(name, listener)
    socket.addEventListener('close', () => {
      for (const [name, listener] of listeners) diagnostics.unsubscribe(name, listener)
    })
    socket.addEventListener('error', () =>
      rejectBeforeClosingSocket(
        new Error(
          `Could not reach OpenAI realtime${socketFailureDetail ? `: ${socketFailureDetail}` : ''}`,
        ),
      ),
    )
    socket.addEventListener('open', () => {
      for (const event of [
        {
          type: 'session.update',
          session: {
            type: 'realtime',
            reasoning: { effort: 'low' },
            output_modalities: ['audio'],
            instructions: INSTRUCTIONS,
            audio: { output: { voice: 'marin', format: { type: 'audio/pcm', rate: 24000 } } },
          },
        },
        {
          type: 'conversation.item.create',
          item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
        },
        { type: 'response.create' },
      ])
        socket.send(JSON.stringify(event))
    })
    socket.addEventListener('message', (message) => {
      const event = JSON.parse(String(message.data))
      if (event.type === 'response.output_audio.delta')
        chunks.push(Buffer.from(event.delta, 'base64'))
      else if (event.type === 'error')
        rejectBeforeClosingSocket(new Error(`OpenAI realtime: ${event.error?.message ?? 'error'}`))
      else if (event.type === 'response.done') {
        socket.close()
        resolve(Buffer.concat(chunks))
      }
    })
  })
}

const spokenAudio = new Map<string, string>()

export default defineExtension({ name: 'sounds' })

export const actions = {
  say: implementAction(SayAction, async (args, { host, signal }) => {
    const text = args && typeof args === 'object' && !Array.isArray(args) ? args.text : undefined
    if (typeof text !== 'string' || !text.trim() || text.length > 300)
      throw new Error('Expected { text } of at most 300 characters')
    const cached = spokenAudio.get(text)
    if (cached) return { audio: cached }
    const key = await openaiSecretOrNonOAuthKey(host, signal)
    if (!key) return { audio: null }
    const audio = (
      await speak(key, text, AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]))
    ).toString('base64')
    spokenAudio.set(text, audio)
    if (spokenAudio.size > 50) spokenAudio.delete(spokenAudio.keys().next().value!)
    return { audio }
  }),
}
