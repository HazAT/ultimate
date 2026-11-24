import { beforeEach, expect, it, vi } from 'vitest'
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
const mic = {
  asked: 0,
  acquired: 0,
  live: 0,
  refuse: undefined as Promise<never> | undefined,
  gate: undefined as Promise<void> | undefined,
}
vi.stubGlobal('navigator', {
  userAgent: '',
  mediaDevices: {
    getUserMedia: () => {
      mic.asked++
      if (mic.refuse) return mic.refuse
      mic.acquired++
      mic.live++
      const stream = { getTracks: () => [{ stop: () => mic.live-- }] }
      return (mic.gate ?? Promise.resolve()).then(() => stream)
    },
  },
})

beforeEach(async () => {
  await endSession()
  actions.length = 0
  mic.acquired = 0
  mic.live = 0
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

it('a retake started while a cancel stops the mic keeps the interruption the cancelled take held', async () => {
  await press()
  dock.hold({ busy: true })
  const cancelled = cancelRecording()
  const retake = press()
  await Promise.all([cancelled, retake])
  expect(dock.held()).toEqual({ busy: true })
  await cancelRecording()
})

it('End skips a queued mic start and releases one already in flight', async () => {
  let open = () => {}
  mic.gate = new Promise((resolve) => (open = resolve))
  const first = press()
  await vi.waitFor(() => expect(mic.acquired).toBe(1))
  const cancelled = cancelRecording()
  const retake = press()
  const ended = endSession()
  mic.gate = undefined
  open()
  await Promise.all([ended, first, cancelled, retake])
  expect(mic).toMatchObject({ acquired: 1, live: 0 })
  expect(talking()).toBe(false)
  expect(dock.mic.recording()).toBe(false)
})

it('a mic start that fails after End cannot revive the retake queued behind it', async () => {
  let refuse: (error: Error) => void = () => {}
  mic.refuse = new Promise((_, reject) => (refuse = reject))
  mic.asked = 0
  const first = press()
  await vi.waitFor(() => expect(mic.asked).toBe(1))
  const cancelled = cancelRecording()
  const retake = press()
  const ended = endSession()
  mic.refuse = undefined
  refuse(new DOMException('Permission denied', 'NotAllowedError'))
  await Promise.allSettled([ended, first, cancelled, retake])
  expect(mic).toMatchObject({ acquired: 0, live: 0 })
  expect(talking()).toBe(false)
  await press()
  expect(dock.mic.recording()).toBe(true)
  await cancelRecording()
})

it('cancelling a retake before its mic starts resumes the reply the first take paused', async () => {
  await press()
  const resume = vi.spyOn(dock.player, 'resume')
  vi.spyOn(dock.player.state, 'get').mockReturnValue({
    ...dock.player.state.get(),
    paused: true,
  })
  dock.hold({ busy: true })
  const cancelled = cancelRecording()
  const retake = press()
  const retakeCancelled = cancelRecording()
  await Promise.all([cancelled, retake, retakeCancelled])
  expect(resume).toHaveBeenCalledOnce()
  expect(talking()).toBe(false)
  vi.restoreAllMocks()
  vi.spyOn(performance, 'now').mockImplementation(() => now)
})
