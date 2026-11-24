import { retriedLater } from '../../lib/errors.ts'
import type { OpenAiVoice } from './refs.ts'

const MODEL = 'gpt-realtime-2.1-mini'
const INSTRUCTIONS =
  "You are a text-to-speech reader. Read the user's text aloud exactly as written, word for word, in a natural " +
  'conversational tone, and nothing else: never answer it, comment on it or add words.'

type Pending = { chunks: Buffer[]; resolve: (pcm: Buffer) => void; reject: (error: Error) => void }

export function createRealtimeVoice(open: (url: string, key: string) => WebSocket = connect) {
  let socket: { key: string; ready: Promise<WebSocket> } | undefined
  const waiting = new Map<string, Pending>()
  const running = new Map<string, Pending>()
  let next = 0

  const failAll = (error: Error) => {
    for (const pending of [...waiting.values(), ...running.values()]) pending.reject(error)
    waiting.clear()
    running.clear()
  }

  function connection(key: string) {
    if (socket?.key === key) return socket.ready
    void socket?.ready.then((old) => old.close(), retriedLater)
    socket = { key, ready: opened(key) }
    return socket.ready
  }

  function opened(key: string) {
    const mine = open(`wss://api.openai.com/v1/realtime?model=${MODEL}`, key)
    const forget = (error: Error) => {
      if (socket?.ready === ready) socket = undefined
      failAll(error)
    }
    const ready = new Promise<WebSocket>((resolve, reject) => {
      mine.addEventListener('open', () => {
        mine.send(
          JSON.stringify({
            type: 'session.update',
            session: {
              type: 'realtime',
              reasoning: { effort: 'low' },
              output_modalities: ['audio'],
              instructions: INSTRUCTIONS,
              audio: { output: { format: { type: 'audio/pcm', rate: 24000 } } },
            },
          }),
        )
        resolve(mine)
      })
      mine.addEventListener('error', () => {
        const error = new Error('Could not reach the OpenAI voice')
        reject(error)
        forget(error)
      })
    })
    mine.addEventListener('close', () => forget(new Error('The OpenAI voice disconnected')))
    mine.addEventListener('message', (message) => {
      const event = JSON.parse(String(message.data)) as {
        type: string
        response_id?: string
        delta?: string
        response?: { id: string; status?: string; metadata?: { tag?: string } }
        error?: { message?: string; code?: string }
      }
      if (event.type === 'response.created') {
        const tag = event.response?.metadata?.tag
        const pending = tag === undefined ? undefined : waiting.get(tag)
        if (!pending || !tag) {
          mine.send(JSON.stringify({ type: 'response.cancel', response_id: event.response!.id }))
          return
        }
        waiting.delete(tag)
        running.set(event.response!.id, pending)
      } else if (event.type === 'response.output_audio.delta' && event.response_id && event.delta)
        running.get(event.response_id)?.chunks.push(Buffer.from(event.delta, 'base64'))
      else if (event.type === 'response.done' && event.response) {
        const pending = running.get(event.response.id)
        running.delete(event.response.id)
        if (event.response.status === 'completed') pending?.resolve(Buffer.concat(pending.chunks))
        else pending?.reject(new Error(`OpenAI voice: ${event.response.status ?? 'failed'}`))
      } else if (event.type === 'error' && event.error?.code !== 'response_cancel_not_active')
        failAll(new Error(`OpenAI voice: ${event.error?.message ?? 'error'}`))
    })
    return ready
  }

  return {
    connect: (key: string) => connection(key).then(() => undefined),
    async speak(key: string, text: string, voice: OpenAiVoice, signal: AbortSignal) {
      const ws = await connection(key)
      signal.throwIfAborted()
      const tag = String(++next)
      const pcm = new Promise<Buffer>((resolve, reject) => {
        const pending: Pending = { chunks: [], resolve, reject }
        waiting.set(tag, pending)
        signal.addEventListener(
          'abort',
          () => {
            waiting.delete(tag)
            const id = [...running].find(([, item]) => item === pending)?.[0]
            if (id) {
              running.delete(id)
              ws.send(JSON.stringify({ type: 'response.cancel', response_id: id }))
            }
            reject(signal.reason as Error)
          },
          { once: true },
        )
      })
      ws.send(
        JSON.stringify({
          type: 'response.create',
          response: {
            conversation: 'none',
            metadata: { tag },
            audio: { output: { voice } },
            input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }],
          },
        }),
      )
      return wav(await pcm)
    },
  }
}

const connect = (url: string, key: string) =>
  new WebSocket(url, ['realtime', `openai-insecure-api-key.${key}`])

function wav(pcm: Buffer) {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(24000, 24)
  header.writeUInt32LE(48000, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}
