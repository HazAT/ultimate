import { expect, it } from 'vitest'
import { createRealtimeVoice } from '../openai-voice.ts'

function fakeRealtime() {
  const sent: {
    type: string
    response_id?: string
    response?: { metadata: { tag: string }; audio: unknown }
  }[] = []
  const listeners = new Map<string, (event: { data?: string }) => void>()
  const socket = {
    send: (data: string) => sent.push(JSON.parse(data)),
    close: () => listeners.get('close')?.({}),
    addEventListener: (type: string, listener: (event: { data?: string }) => void) =>
      listeners.set(type, listener),
  }
  const opened: string[] = []
  const voice = createRealtimeVoice((url, key) => {
    opened.push(`${url} ${key}`)
    queueMicrotask(() => listeners.get('open')?.({}))
    return socket as unknown as WebSocket
  })
  const event = (data: object) => listeners.get('message')!({ data: JSON.stringify(data) })
  return { voice, sent, opened, event }
}

const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve))

it('reads several sentences at once on one connection and cancels an aborted one', async () => {
  const { voice, sent, opened, event } = fakeRealtime()
  const first = voice.speak('sk', 'One.', 'cedar', new AbortController().signal)
  const aborting = new AbortController()
  const second = voice.speak('sk', 'Two.', 'ash', aborting.signal)
  await flush()
  await flush()
  expect(opened).toEqual(['wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1-mini sk'])
  const creates = sent.filter((item) => item.type === 'response.create')
  expect(creates.map((item) => item.response!.audio)).toEqual([
    { output: { voice: 'cedar' } },
    { output: { voice: 'ash' } },
  ])
  event({
    type: 'response.created',
    response: { id: 'r1', metadata: creates[0].response!.metadata },
  })
  event({
    type: 'response.created',
    response: { id: 'r2', metadata: creates[1].response!.metadata },
  })
  event({
    type: 'response.output_audio.delta',
    response_id: 'r1',
    delta: Buffer.from([1, 2]).toString('base64'),
  })
  aborting.abort(new Error('cut in'))
  await expect(second).rejects.toThrow('cut in')
  expect(sent.at(-1)).toEqual({ type: 'response.cancel', response_id: 'r2' })
  event({
    type: 'response.output_audio.delta',
    response_id: 'r1',
    delta: Buffer.from([3, 4]).toString('base64'),
  })
  event({ type: 'response.done', response: { id: 'r1', status: 'completed' } })
  const wav = await first
  expect(wav.subarray(0, 4).toString()).toBe('RIFF')
  expect([...wav.subarray(44)]).toEqual([1, 2, 3, 4])
})
