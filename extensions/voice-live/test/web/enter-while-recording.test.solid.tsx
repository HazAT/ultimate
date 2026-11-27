import { flush } from 'solid-js'
import { beforeEach, expect, it, vi } from 'vitest'
import { parseConversationId } from '../../../../lib/ids.shared.ts'
import { capture } from '../../../dictation/ui.solid.tsx'
import {
  composeIn,
  dock,
  endSession,
  sendDraft,
  sendTyped,
  settleTranscripts,
  voiceSink,
} from '../../dock.solid.tsx'

const harness = vi.hoisted(() => ({
  turns: [] as Record<string, unknown>[],
  record: undefined as Promise<void> | undefined,
}))
vi.mock('@/sdk/solid', async () => {
  const { createSignal } = await import('solid-js')
  return {
    writerNow: () => 'person',
    writingAs: <T,>(_who: unknown, write: () => T) => write(),
    api: {
      action: (ref: { name: string }, args: Record<string, unknown>) => {
        if (ref.name === 'status') return Promise.resolve({ route: 'text' })
        if (ref.name === 'record')
          return Promise.resolve(harness.record).then(() => ({ audio: 'rec-1', session: 40 }))
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
  harness.record = undefined
  composeIn(parseConversationId(40))
})

const session = parseConversationId(40)
const shot = { data: 'cG5n', mimeType: 'image/png' }

it('Enter during a recording stops it and sends the typed text, the image and its transcript as one turn', async () => {
  dock.setCollect(false)
  await capture.press(voiceSink)?.started
  speak()
  const sent = sendTyped('look at this', [shot])
  await vi.waitFor(() => expect(capture.talking(voiceSink)).toBe(false))
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

it('Enter during a recording while collecting sends the collected clips, the new one and the text as one turn', async () => {
  dock.setCollect(true)
  flush()
  const earlier = { audio: 'clip-0', seconds: 2 }
  settleTranscripts({ draft: [earlier] }, session)
  await capture.press(voiceSink)?.started
  speak()
  let uploaded = () => {}
  harness.record = new Promise((resolve) => (uploaded = resolve))
  const sent = sendTyped('look at this', [shot])
  await vi.waitFor(() => expect(capture.talking(voiceSink)).toBe(false))
  await sendDraft('followUp')
  uploaded()
  settleTranscripts(
    { draft: [earlier], transcripts: { 'clip-0': 'first', 'rec-1': 'second' } },
    session,
  )
  await sent
  expect(harness.turns).toEqual([
    expect.objectContaining({
      text: 'first second\n\nlook at this',
      clips: ['clip-0', 'rec-1'],
      images: [shot],
    }),
  ])
})

it('End while Enter stops the recording sends nothing and leaves the typed text in the box', async () => {
  dock.setCollect(false)
  await capture.press(voiceSink)?.started
  speak()
  const sent = sendTyped('look at this')
  await endSession()
  await expect(sent).rejects.toThrow('The voice session ended')
  expect(harness.turns).toEqual([])
})
