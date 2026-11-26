import { beforeEach, expect, it, vi } from 'vitest'
import { parseConversationId } from '../../../../lib/ids.ts'
import { capture } from '../../../dictation/ui.solid.tsx'
import {
  composeIn,
  dock,
  endSession,
  sendTyped,
  settleTranscripts,
  voiceSink,
} from '../../dock.solid.tsx'

const harness = vi.hoisted(() => ({ turns: [] as Record<string, unknown>[] }))
vi.mock('@/sdk/solid', async () => {
  const { createSignal } = await import('solid-js')
  return {
    api: {
      action: (ref: { name: string }, args: Record<string, unknown>) => {
        if (ref.name === 'status') return Promise.resolve({ route: 'text' })
        if (ref.name === 'record') return Promise.resolve({ audio: 'rec-1', session: 40 })
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
    useUiState: (key: string, initial: unknown) =>
      createSignal<unknown>(key === 'ext.voice-live.cues' ? false : initial),
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
  await endSession()
  harness.turns.length = 0
  composeIn(parseConversationId(40))
})

it.each([false, true])(
  'Enter during a recording stops it and sends the typed text with its transcript as one turn (collect: %s)',
  async (collect) => {
    dock.setCollect(collect)
    await capture.press(voiceSink)?.started
    speak()
    const sent = sendTyped('look at this')
    await vi.waitFor(() => expect(capture.talking(voiceSink)).toBe(false))
    expect(harness.turns).toEqual([])
    settleTranscripts({ transcripts: { 'rec-1': 'hello there' } }, parseConversationId(40))
    await sent
    expect(harness.turns).toEqual([
      expect.objectContaining({ text: 'hello there\n\nlook at this', audio: 'rec-1' }),
    ])
  },
)
