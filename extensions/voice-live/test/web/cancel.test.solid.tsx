import { expect, it, vi } from 'vitest'
import { parseConversationId } from '../../../../lib/ids.ts'
import {
  cancelRecording,
  composeIn,
  dock,
  draftOf,
  endSession,
  press,
  release,
  settleTranscripts,
  talking,
} from '../../dock.solid.tsx'

const actions = vi.hoisted(() => [] as string[])
vi.mock('@/sdk/solid', async () => {
  const { createSignal } = await import('solid-js')
  return {
    api: {
      action: (ref: { name: string }) => {
        actions.push(ref.name)
        return Promise.resolve({})
      },
    },
    composerDraft: () => ({
      text: '',
      images: [],
      files: 0,
      reserve: () => () => {},
      subscribe: () => () => {},
    }),
    errorMessage: String,
    useConversation: () => () => ({ entries: [], live: {}, busy: false }),
    useUiState: (key: string, initial: unknown) =>
      createSignal<unknown>(key === 'ext.voice-live.cues' ? false : initial),
  }
})

class FakeRecorder extends EventTarget {
  static isTypeSupported = () => true
  mimeType = 'audio/webm'
  start() {}
  stop() {
    this.dispatchEvent(new Event('stop'))
  }
}
vi.stubGlobal('speechSynthesis', { cancel() {}, speak() {} })
vi.stubGlobal('isSecureContext', true)
vi.stubGlobal('MediaRecorder', FakeRecorder)
const frames: Array<() => void> = []
vi.stubGlobal('requestAnimationFrame', (tick: () => void) => frames.push(tick))
const speak = () => {
  for (let at = 0; at < 10; at++) frames.splice(0).forEach((tick) => tick())
  now += 2000
}
let now = 0
vi.spyOn(performance, 'now').mockImplementation(() => now)
vi.stubGlobal('cancelAnimationFrame', () => {})
vi.stubGlobal('matchMedia', () => ({ matches: false }))
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
  mediaDevices: { getUserMedia: () => Promise.resolve({ getTracks: () => [] }) },
})

it('cancelling a spoken recording uploads nothing and keeps the collected clips; the next take records and uploads', async () => {
  const session = parseConversationId(40)
  const clips = [{ audio: 'clip-1', seconds: 2 }]
  composeIn(session)
  settleTranscripts({ of: parseConversationId(1), draft: clips }, session)
  dock.setCollect(true)

  await press()
  expect(dock.capturing()).toBe(true)
  speak()
  await cancelRecording()
  await release()
  expect(talking()).toBe(false)
  expect(dock.capturing()).toBe(false)
  expect(dock.phase()).toBe('idle')
  expect(actions).toEqual([])
  expect(draftOf()).toEqual(clips)

  await press()
  speak()
  const sending = release()
  await vi.waitFor(() => expect(actions).toEqual(['record']))
  await endSession()
  await sending
})

it('a cancel while the mic is still starting lets a fresh press record once it has started', async () => {
  const first = press()
  const cancelled = cancelRecording()
  const second = press()
  await Promise.all([first, cancelled, second])
  expect(talking()).toBe(true)
  expect(dock.capturing()).toBe(true)
  expect(dock.mic.recording()).toBe(true)
  await cancelRecording()
  expect(dock.mic.recording()).toBe(false)
})
