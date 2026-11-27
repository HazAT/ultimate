import { beforeEach, expect, it, vi } from 'vitest'
import { parseConversationId } from '../../../../lib/ids.shared.ts'
import { serverEndedSession } from './session.ts'
import { capture } from '../../../dictation/ui.solid.tsx'
import { composeIn, dock, draftOf, settleTranscripts, voiceSink } from '../../dock.solid.tsx'

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
  mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) },
})

const press = () => capture.press(voiceSink)?.started
const release = () => capture.take(voiceSink)?.release()
const cancelRecording = () => capture.take(voiceSink)?.cancel()
const talking = () => capture.talking(voiceSink)

beforeEach(async () => {
  await serverEndedSession(composeIn)
  actions.length = 0
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
  await serverEndedSession(composeIn)
  await sending
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
