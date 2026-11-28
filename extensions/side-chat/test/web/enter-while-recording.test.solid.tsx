import { beforeEach, expect, it, vi } from 'vitest'
import { parseConversationId } from '../../../../lib/ids.shared.ts'
import { serverEndedSession } from './session.ts'
import { capture } from '../../../dictation/ui.solid.tsx'
import {
  composeIn,
  sendTyped,
  setSideChatSource,
  settleTranscripts,
  sideChatSink,
} from '../../dock.solid.tsx'

const harness = vi.hoisted(() => ({
  stops: 0,
  stopFails: false,
  turns: [] as Record<string, unknown>[],
  recordings: [] as Record<string, unknown>[],
}))
vi.mock('@/sdk/solid', async () => {
  const { createSignal } = await import('solid-js')
  return {
    writerNow: () => 'person',
    writingAs: <T,>(_who: unknown, write: () => T) => write(),
    api: {
      action: (ref: { name: string }, args: Record<string, unknown>) => {
        if (ref.name === 'stop') {
          harness.stops++
          if (harness.stopFails) return Promise.reject(new Error('stop failed'))
        }
        if (ref.name === 'status') return Promise.resolve({ route: 'text', forkable: true })
        if (ref.name === 'record') {
          harness.recordings.push(args)
          return Promise.resolve({ audio: 'rec-1', session: 40 })
        }
        if (ref.name === 'turn') {
          harness.turns.push(args)
          return Promise.resolve({ conversation: 40 })
        }
        return Promise.resolve({})
      },
    },
    composerDraft: () => ({
      text: '',
      images: [],
      files: 0,
      attachments: [],
      reserve: () => () => {},
      subscribe: () => () => {},
    }),
    errorMessage: String,
    events: { emit() {} },
    useConversation: () => () => ({ entries: [], live: {}, busy: false }),
    ROOT: 1,
    useAction: () => ({ data: () => undefined, refetch: async () => undefined }),
    useDocOf: () => () => undefined,
    useUiState: (key: string, initial: unknown) =>
      createSignal<unknown>(key === 'ext.side-chat.cues' ? false : initial),
  }
})

class FakeRecorder extends EventTarget {
  static isTypeSupported = () => true
  mimeType = 'audio/webm'
  state = 'inactive'
  start() {
    this.state = 'recording'
    this.dispatchEvent(Object.assign(new Event('dataavailable'), { data: new Blob(['a']) }))
  }
  stop() {
    this.state = 'inactive'
    this.dispatchEvent(new Event('stop'))
  }
}
vi.stubGlobal('speechSynthesis', { cancel() {}, speak() {} })
vi.stubGlobal('isSecureContext', true)
vi.stubGlobal('MediaRecorder', FakeRecorder)
const frames: Array<() => void> = []
vi.stubGlobal('requestAnimationFrame', (tick: () => void) => frames.push(tick))
vi.stubGlobal('cancelAnimationFrame', () => {})
vi.stubGlobal('matchMedia', () => ({ matches: false }))
let now = 0
vi.spyOn(performance, 'now').mockImplementation(() => now)
vi.stubGlobal(
  'AudioContext',
  class {
    state = 'running'
    close = () => Promise.resolve()
    createAnalyser = () => ({
      fftSize: 8,
      getFloatTimeDomainData: (samples: Float32Array) => samples.fill(0.5),
    })
    createMediaStreamSource = () => ({ connect() {} })
  },
)
vi.stubGlobal('navigator', {
  userAgent: '',
  mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) },
})

const speak = () => {
  for (let at = 0; at < 10; at++) frames.splice(0).forEach((tick) => tick())
  now += 2000
}

beforeEach(async () => {
  await serverEndedSession(composeIn)
  setSideChatSource(undefined)
  harness.turns.length = 0
  harness.recordings.length = 0
  harness.stops = 0
  harness.stopFails = false
  composeIn(parseConversationId(40))
})

const session = parseConversationId(40)
const shot = { data: 'cG5n', mimeType: 'image/png' }

it('Enter during a recording stops it and sends the typed text, the image and its transcript as one turn', async () => {
  await capture.press(sideChatSink)?.started
  speak()
  const sent = sendTyped('look at this', [shot])
  await vi.waitFor(() => expect(capture.talking(sideChatSink)).toBe(false))
  expect(harness.turns).toEqual([])
  settleTranscripts({ transcripts: { 'rec-1': 'hello there' } }, session)
  await sent
  expect(harness.turns).toEqual([
    expect.objectContaining({
      text: 'hello there\n\nlook at this',
      audio: 'rec-1',
      images: [shot],
    }),
  ])
})

it('switching sources while Enter releases a first recording cancels it without sending the audio or typed draft', async () => {
  composeIn(undefined)
  setSideChatSource(parseConversationId(42))
  await capture.press(sideChatSink)?.started
  speak()
  const sent = sendTyped('look at this', [shot])
  setSideChatSource(parseConversationId(43))
  await expect(sent).rejects.toThrow('The side chat source changed')
  expect(harness.recordings).toEqual([])
  expect(harness.turns).toEqual([])
})

it('a session that ends while Enter stops the recording sends nothing and leaves the typed text in the box', async () => {
  await capture.press(sideChatSink)?.started
  speak()
  const sent = sendTyped('look at this')
  await serverEndedSession(composeIn)
  await expect(sent).rejects.toThrow('The side chat ended')
  expect(harness.turns).toEqual([])
})
