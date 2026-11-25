import { inProcess } from '../../lib/errors.ts'
import { within } from '../../lib/timers.ts'
import type { OpenAiVoice } from './refs.ts'

const MODEL = 'gpt-realtime-2.1-mini'
const CONNECT_TIMEOUT_MS = 10_000
const INSTRUCTIONS =
  "You are a text-to-speech reader. Read the user's text aloud exactly as written, word for word, in a natural " +
  'conversational tone, and nothing else: never answer it, comment on it or add words.'

type Pending = { chunks: Buffer[]; resolve: (pcm: Buffer) => void; reject: (error: Error) => void }
type Connection = {
  key: string
  socket: WebSocket
  ready: Promise<WebSocket>
  waiting: Map<string, Pending>
  running: Map<string, Pending>
}
type RealtimeEvent = {
  type: string
  response_id?: string
  delta?: string
  response?: { id: string; status?: string; metadata?: { tag?: string } }
  error?: { message?: string; code?: string; event_id?: string }
}

export function createRealtimeVoice(open: (url: string, key: string) => WebSocket = connect) {
  let current: Connection | undefined
  let next = 0

  function connection(key: string) {
    if (current?.key === key) return current
    current?.socket.close()
    current = opened(key)
    return current
  }

  function opened(key: string): Connection {
    const socket = open(`wss://api.openai.com/v1/realtime?model=${MODEL}`, key)
    const waiting = new Map<string, Pending>()
    const running = new Map<string, Pending>()
    const failAll = (error: Error) => {
      for (const pending of [...waiting.values(), ...running.values()]) pending.reject(error)
      waiting.clear()
      running.clear()
    }
    const forget = (error: Error) => {
      if (current === own) current = undefined
      failAll(error)
    }
    const ready = new Promise<WebSocket>((resolve, reject) => {
      socket.addEventListener('open', () => {
        socket.send(
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
        resolve(socket)
      })
      socket.addEventListener('error', () => reject(new Error('Could not reach the OpenAI voice')))
      socket.addEventListener('close', () =>
        reject(new Error('The OpenAI voice closed before it opened')),
      )
    })
    const bounded = within(
      CONNECT_TIMEOUT_MS,
      ready,
      () => new Error('The OpenAI voice did not connect in time'),
    )
    inProcess(
      'a voice socket lives in this process only',
      bounded.catch((error: Error) => {
        forget(error)
        socket.close()
      }),
    )
    socket.addEventListener('close', () => forget(new Error('The OpenAI voice disconnected')))
    socket.addEventListener('message', (message) => {
      const event = JSON.parse(String(message.data)) as RealtimeEvent
      if (event.type === 'response.created' && event.response) {
        const tag = event.response.metadata?.tag
        const pending = tag === undefined ? undefined : waiting.get(tag)
        if (!pending || tag === undefined) {
          socket.send(JSON.stringify({ type: 'response.cancel', response_id: event.response.id }))
          return
        }
        waiting.delete(tag)
        running.set(event.response.id, pending)
      } else if (event.type === 'response.output_audio.delta' && event.response_id && event.delta)
        running.get(event.response_id)?.chunks.push(Buffer.from(event.delta, 'base64'))
      else if (event.type === 'response.done' && event.response) {
        const pending = running.get(event.response.id)
        running.delete(event.response.id)
        if (event.response.status === 'completed') pending?.resolve(Buffer.concat(pending.chunks))
        else pending?.reject(new Error(`OpenAI voice: ${event.response.status ?? 'failed'}`))
      } else if (event.type === 'error') {
        if (event.error?.code === 'response_cancel_not_active') return
        const error = new Error(`OpenAI voice: ${event.error?.message ?? 'error'}`)
        const tag = event.error?.event_id
        const pending = tag === undefined ? undefined : waiting.get(tag)
        if (pending && tag !== undefined) {
          waiting.delete(tag)
          pending.reject(error)
        } else if (tag === undefined) failAll(error)
      }
    })
    const own: Connection = { key, socket, ready: bounded, waiting, running }
    return own
  }

  const waitFor = (ready: Promise<WebSocket>, signal: AbortSignal) =>
    new Promise<WebSocket>((resolve, reject) => {
      signal.throwIfAborted()
      const aborted = () => reject(signal.reason as Error)
      signal.addEventListener('abort', aborted, { once: true })
      inProcess(
        'a request waits on this process only',
        ready.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted)),
      )
    })

  return {
    connect: (key: string, signal: AbortSignal) =>
      waitFor(connection(key).ready, signal).then(() => undefined),
    async speak(key: string, text: string, voice: OpenAiVoice, signal: AbortSignal) {
      const { ready, waiting, running } = connection(key)
      const ws = await waitFor(ready, signal)
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
          event_id: tag,
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
    close() {
      current?.socket.close()
      current = undefined
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
