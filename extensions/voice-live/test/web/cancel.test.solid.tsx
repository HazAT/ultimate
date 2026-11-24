import { expect, it, vi } from 'vitest'
import { parseConversationId } from '../../../../lib/ids.ts'
import {
  cancelRecording,
  composeIn,
  dock,
  draftOf,
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
vi.stubGlobal('requestAnimationFrame', () => 0)
vi.stubGlobal('cancelAnimationFrame', () => {})
vi.stubGlobal('matchMedia', () => ({ matches: false }))
vi.stubGlobal(
  'AudioContext',
  class {
    state = 'running'
    createAnalyser = () => ({ fftSize: 0, getFloatTimeDomainData() {} })
    createMediaStreamSource = () => ({ connect() {} })
  },
)
vi.stubGlobal('navigator', {
  userAgent: '',
  mediaDevices: { getUserMedia: () => Promise.resolve({ getTracks: () => [] }) },
})

it('cancelling a recording uploads nothing, keeps the collected clips, and the next press records anew', async () => {
  const session = parseConversationId(40)
  const clips = [{ audio: 'clip-1', seconds: 2 }]
  composeIn(session)
  settleTranscripts({ of: parseConversationId(1), draft: clips }, session)
  dock.setCollect(true)

  await press()
  expect(dock.phase()).toBe('recording')
  await cancelRecording()
  await release()
  expect(talking()).toBe(false)
  expect(dock.phase()).toBe('idle')
  expect(actions).toEqual([])
  expect(draftOf()).toEqual(clips)

  await press()
  expect(dock.phase()).toBe('recording')
  await cancelRecording()
})
