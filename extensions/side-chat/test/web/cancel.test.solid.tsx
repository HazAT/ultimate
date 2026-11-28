import { beforeEach, expect, it, vi } from 'vitest'
import { serverEndedSession } from './session.ts'
import { capture } from '../../../dictation/ui.solid.tsx'
import { composeIn, dispatch, dock, sideChatSink } from '../../dock.solid.tsx'
import { flush } from 'solid-js'

const actions = vi.hoisted(() => [] as string[])
vi.mock('@/sdk/solid', async () => {
  const { createSignal } = await import('solid-js')
  return {
    writerNow: () => 'person',
    writingAs: <T,>(_who: unknown, write: () => T) => write(),
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
      attachments: [],
      reserve: () => () => {},
      subscribe: () => () => {},
    }),
    errorMessage: String,
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
  mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) },
})

const press = () => capture.press(sideChatSink)?.started
const cancelRecording = () => capture.take(sideChatSink)?.cancel()
const talking = () => capture.talking(sideChatSink)

beforeEach(async () => {
  await serverEndedSession(composeIn)
  actions.length = 0
})

it('a retake started while a cancel stops the mic keeps the interruption the cancelled take held', async () => {
  await press()
  dispatch({ type: 'press', busy: true })
  const cancelled = cancelRecording()
  const retake = press()
  await Promise.all([cancelled, retake])
  flush()
  expect(dock.state()).toMatchObject({ phase: 'recording', busy: true })
  await cancelRecording()
})

it('cancelling a retake before its mic starts resumes the reply the first take paused', async () => {
  dock.player.load('reply', [], false)
  await press()
  const resume = vi.spyOn(dock.player, 'resume')
  vi.spyOn(dock.player.state, 'get').mockReturnValue({
    ...dock.player.state.get(),
    key: 'reply',
    paused: true,
  })
  dispatch({ type: 'press', busy: true })
  const cancelled = cancelRecording()
  const retake = press()
  const retakeCancelled = cancelRecording()
  await Promise.all([cancelled, retake, retakeCancelled])
  expect(resume).toHaveBeenCalledOnce()
  expect(talking()).toBe(false)
  vi.restoreAllMocks()
  vi.spyOn(performance, 'now').mockImplementation(() => now)
})
