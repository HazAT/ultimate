import { expect, it } from 'vitest'
import { createRealtimeVoice } from '../openai-voice.ts'
import { until } from '../../../test/helpers.ts'

type Sent = {
  type: string
  event_id?: string
  response_id?: string
  response?: { metadata: { tag: string }; audio: unknown }
}

function fakeRealtime({ closeLate = false } = {}) {
  const sockets: {
    sent: Sent[]
    listeners: Map<string, ((event: { data?: string }) => void)[]>
    closed: boolean
    finishClose: () => void
  }[] = []
  const voice = createRealtimeVoice(() => {
    const own = {
      sent: [] as Sent[],
      listeners: new Map<string, ((event: { data?: string }) => void)[]>(),
      closed: false,
      finishClose: () => emit('close'),
    }
    sockets.push(own)
    const emit = (type: string, event: { data?: string } = {}) => {
      for (const listener of own.listeners.get(type) ?? []) listener(event)
    }
    queueMicrotask(() => emit('open'))
    return {
      send: (data: string) => own.sent.push(JSON.parse(data)),
      close: () => {
        own.closed = true
        if (!closeLate) emit('close')
      },
      addEventListener: (type: string, listener: (event: { data?: string }) => void) =>
        own.listeners.set(type, [...(own.listeners.get(type) ?? []), listener]),
    } as unknown as WebSocket
  })
  const event = (data: object, at = sockets.length - 1) => {
    for (const listener of sockets[at].listeners.get('message') ?? [])
      listener({ data: JSON.stringify(data) })
  }
  const creates = (at = sockets.length - 1) =>
    sockets[at].sent.filter((item) => item.type === 'response.create')
  return { voice, sockets, event, creates }
}

const audio = (bytes: number[]) => Buffer.from(bytes).toString('base64')

it('reads several sentences at once on one connection and cancels an aborted one', async () => {
  const { voice, sockets, event, creates } = fakeRealtime()
  const first = voice.speak('sk', 'One.', 'cedar', new AbortController().signal)
  const aborting = new AbortController()
  const second = voice.speak('sk', 'Two.', 'ash', aborting.signal)
  await until(() => creates().length === 2)
  expect(sockets).toHaveLength(1)
  expect(creates().map((item) => item.response!.audio)).toEqual([
    { output: { voice: 'cedar' } },
    { output: { voice: 'ash' } },
  ])
  event({
    type: 'response.created',
    response: { id: 'r1', metadata: creates()[0].response!.metadata },
  })
  event({
    type: 'response.created',
    response: { id: 'r2', metadata: creates()[1].response!.metadata },
  })
  event({ type: 'response.output_audio.delta', response_id: 'r1', delta: audio([1, 2]) })
  aborting.abort(new Error('cut in'))
  await expect(second).rejects.toThrow('cut in')
  expect(sockets[0].sent.at(-1)).toEqual({ type: 'response.cancel', response_id: 'r2' })
  event({ type: 'response.output_audio.delta', response_id: 'r1', delta: audio([3, 4]) })
  event({ type: 'response.done', response: { id: 'r1', status: 'completed' } })
  expect(await first).toEqual(Buffer.from([1, 2, 3, 4]))
})

it('an error about one request fails only that request', async () => {
  const { voice, event, creates } = fakeRealtime()
  const good = voice.speak('sk', 'Fine.', 'cedar', new AbortController().signal)
  const bad = voice.speak('sk', 'Broken.', 'cedar', new AbortController().signal)
  await until(() => creates().length === 2)
  event({
    type: 'response.created',
    response: { id: 'r1', metadata: creates()[0].response!.metadata },
  })
  event({ type: 'error', error: { message: 'Invalid value', event_id: creates()[1].event_id } })
  await expect(bad).rejects.toThrow('Invalid value')
  event({ type: 'response.output_audio.delta', response_id: 'r1', delta: audio([9]) })
  event({ type: 'response.done', response: { id: 'r1', status: 'completed' } })
  expect(await good).toEqual(Buffer.from([9]))
})

it('a key change retires the old socket, and its late close fails nothing on the new one', async () => {
  const { voice, sockets, event, creates } = fakeRealtime({ closeLate: true })
  await voice.connect('old', new AbortController().signal)
  const fresh = voice.speak('new', 'Hello.', 'cedar', new AbortController().signal)
  await until(() => creates(1).length === 1)
  expect(sockets[0].closed).toBe(true)
  sockets[0].finishClose()
  event(
    {
      type: 'response.created',
      response: { id: 'r1', metadata: creates(1)[0].response!.metadata },
    },
    1,
  )
  event({ type: 'response.output_audio.delta', response_id: 'r1', delta: audio([5]) }, 1)
  event({ type: 'response.done', response: { id: 'r1', status: 'completed' } }, 1)
  expect(await fresh).toEqual(Buffer.from([5]))
})

it('after a disconnect the same key opens a new socket', async () => {
  const { voice, sockets, event, creates } = fakeRealtime()
  await voice.connect('sk', new AbortController().signal)
  sockets[0].finishClose()
  const again = voice.speak('sk', 'Back.', 'cedar', new AbortController().signal)
  await until(() => creates(1).length === 1)
  event(
    {
      type: 'response.created',
      response: { id: 'r1', metadata: creates(1)[0].response!.metadata },
    },
    1,
  )
  event({ type: 'response.done', response: { id: 'r1', status: 'completed' } }, 1)
  expect(await again).toEqual(Buffer.alloc(0))
  expect(sockets).toHaveLength(2)
})

it('a request aborted while the socket connects stops waiting at once', async () => {
  const voice = createRealtimeVoice(
    () =>
      ({
        send: () => {},
        close: () => {},
        addEventListener: () => {},
      }) as unknown as WebSocket,
  )
  const aborting = new AbortController()
  const waiting = voice.speak('sk', 'Hi.', 'cedar', aborting.signal)
  aborting.abort(new Error('deadline'))
  await expect(waiting).rejects.toThrow('deadline')
})
