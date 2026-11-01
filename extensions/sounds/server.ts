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

/** The OpenAI API key: the `OPENAI_API_KEY` secret, else an API key Pi's `openai` provider holds (not its OAuth login). */
async function apiKey(host: Pick<ExtensionHost, 'userHome' | 'modelRuntime'>, signal: AbortSignal) {
  const secret = await readSecret(host.userHome, 'OPENAI_API_KEY')
  if (secret) return secret
  const runtime = host.modelRuntime
  if (!runtime.getProviderAuthStatus('openai').configured || runtime.isUsingOAuth('openai'))
    return undefined
  return (await runtime.getAuth('openai', { signal }))?.auth.apiKey
}

/**
 * Speaks `text` with OpenAI's realtime voice, which replaced the retiring speech endpoint: one response over a WebSocket,
 * its audio as 16-bit mono PCM at 24 kHz.
 */
export function speak(key: string, text: string, signal: AbortSignal) {
  return new Promise<Buffer>((resolve, reject) => {
    // Node's WebSocket sends no headers; the subprotocol carries the key, as OpenAI documents for clients without them.
    const socket = new WebSocket(`wss://api.openai.com/v1/realtime?model=${MODEL}`, [
      'realtime',
      `openai-insecure-api-key.${key}`,
    ])
    const chunks: Buffer[] = []
    const fail = (error: Error) => {
      socket.close()
      reject(error)
    }
    signal.addEventListener('abort', () => fail(new Error('Speaking timed out')), { once: true })
    socket.addEventListener('error', () => fail(new Error('Could not reach OpenAI realtime')))
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
        fail(new Error(`OpenAI realtime: ${event.error?.message ?? 'error'}`))
      else if (event.type === 'response.done') {
        socket.close()
        resolve(Buffer.concat(chunks))
      }
    })
  })
}

/** Lines said before, by text: most repeat ("Ultimate has a question."), and a repeat then plays at once. */
const said = new Map<string, string>()

export default defineExtension({ name: 'sounds' })

export const actions = {
  say: implementAction(SayAction, async (args, { host, signal }) => {
    const text = args && typeof args === 'object' && !Array.isArray(args) ? args.text : undefined
    if (typeof text !== 'string' || !text.trim() || text.length > 300)
      throw new Error('Expected { text } of at most 300 characters')
    const cached = said.get(text)
    if (cached) return { audio: cached }
    const key = await apiKey(host, signal)
    if (!key) return { audio: null }
    const audio = (
      await speak(key, text, AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]))
    ).toString('base64')
    said.set(text, audio)
    if (said.size > 50) said.delete(said.keys().next().value!)
    return { audio }
  }),
}
