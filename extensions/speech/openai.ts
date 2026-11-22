import diagnostics from 'node:diagnostics_channel'
import { openaiError } from '../../lib/openai.ts'
import type { OpenAiVoice } from './api.ts'
import { wavOf } from '../../lib/speech.ts'
import type { Audio } from '../../lib/speech.ts'

const usesRealtimeSocket = (model: string) => model.includes('realtime')

export const openaiVoice = (key: string, text: string, voice: OpenAiVoice, signal: AbortSignal) =>
  usesRealtimeSocket(voice.model)
    ? realtimeSpeech(key, text, voice, signal)
    : speechEndpoint(key, text, voice, signal)

async function speechEndpoint(
  key: string,
  text: string,
  { model, voice, instructions }: OpenAiVoice,
  signal: AbortSignal,
): Promise<Audio> {
  const response = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, voice, input: text, instructions, response_format: 'mp3' }),
    signal,
  })
  if (!response.ok) {
    const { status, message } = await openaiError(response)
    throw new Error(`OpenAI speech failed (HTTP ${status})${message ? `: ${message}` : ''}`)
  }
  return { audio: Buffer.from(await response.arrayBuffer()), mimeType: 'audio/mpeg' }
}

function realtimeSpeech(
  key: string,
  text: string,
  { model, voice, instructions }: OpenAiVoice,
  signal: AbortSignal,
) {
  return new Promise<Audio>((resolve, reject) => {
    const socket = new WebSocket(`wss://api.openai.com/v1/realtime?model=${model}`, [
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
            instructions,
            audio: { output: { voice, format: { type: 'audio/pcm', rate: 24000 } } },
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
        resolve({ audio: wavOf(Buffer.concat(chunks)), mimeType: 'audio/wav' })
      }
    })
  })
}
