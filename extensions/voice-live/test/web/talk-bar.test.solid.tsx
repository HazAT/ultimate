import { createSignal, flush, Show } from 'solid-js'
import { beforeEach, expect, it, vi } from 'vitest'
import { parseConversationId } from '../../../../lib/ids.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { capture } from '../../../dictation/ui.solid.tsx'
import { composeIn, dock, endSession, settleTranscripts, voiceSink } from '../../dock.solid.tsx'
import { TalkBar } from '../../talk.solid.tsx'

const harness = vi.hoisted(() => ({
  calls: [] as { name: string; who?: string }[],
}))
vi.mock('@/sdk/solid', async (original) => {
  const { createSignal: signal } = await import('solid-js')
  const real = await original<typeof import('@/sdk/solid')>()
  return {
    ...real,
    api: {
      action: (ref: { name: string }, _args: unknown, call: { who?: string } = {}) => {
        harness.calls.push({ name: ref.name, who: call.who })
        if (ref.name === 'status') return Promise.resolve({ route: 'text' })
        if (ref.name === 'record') return Promise.resolve({ audio: 'rec-1', session: 40 })
        if (ref.name === 'turn') return Promise.resolve({ conversation: 40 })
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
    events: { emit() {} },
    useConversation: () => () => ({ entries: [], live: {}, busy: false }),
    useUiState: (key: string, initial: unknown) =>
      signal<unknown>(
        key === 'ext.voice-live.cues' ? false : key === 'ext.dictation.talk' ? 'hold' : initial,
      ),
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
vi.stubGlobal('SpeechSynthesisUtterance', EventTarget)
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
HTMLCanvasElement.prototype.getContext = () => null
document.elementFromPoint = () => null

const speak = () => {
  for (let at = 0; at < 10; at++) frames.splice(0).forEach((tick) => tick())
  now += 2000
}
const touch = (type: string, pointerId = 1) =>
  new PointerEvent(type, { bubbles: true, pointerId, pointerType: 'touch' })

beforeEach(async () => {
  await endSession()
  harness.calls.length = 0
  dock.setCollect(false)
  composeIn(parseConversationId(40))
})

it('a hold that started in the main box ends when the finger lifts, though the bar unmounted as voice opened', async () => {
  const [shown, setShown] = createSignal(true)
  const view = renderSolid(() => (
    <Show when={shown()}>
      <TalkBar onTalk={() => setShown(false)} />
    </Show>
  ))
  view.querySelector('[data-voice-talk]')!.dispatchEvent(touch('pointerdown'))
  flush()
  expect(view.querySelector('[data-voice-talk]')).toBeNull()
  await vi.waitFor(() => expect(capture.capturing(voiceSink)).toBe(true))
  speak()
  window.dispatchEvent(touch('pointerup', 2))
  expect(capture.talking(voiceSink)).toBe(true)
  window.dispatchEvent(touch('pointerup'))
  await vi.waitFor(() => expect(capture.talking(voiceSink)).toBe(false))
  settleTranscripts({ transcripts: { 'rec-1': 'hello' } }, parseConversationId(40))
  await vi.waitFor(() => expect(harness.calls.map((call) => call.name)).toContain('turn'))
})

it('a take an agent starts records and sends as the agent, after the mic has shut down', async () => {
  const { writingAs } = await import('@/sdk/solid')
  await writingAs('agent', () => capture.press(voiceSink))?.started
  speak()
  const released = capture.take(voiceSink)!.release()
  await vi.waitFor(() => expect(harness.calls.map((call) => call.name)).toContain('record'))
  settleTranscripts({ transcripts: { 'rec-1': 'hello' } }, parseConversationId(40))
  await released
  const writes = harness.calls.filter((call) => call.name === 'record' || call.name === 'turn')
  expect(writes).toEqual([
    { name: 'record', who: 'agent' },
    { name: 'turn', who: 'agent' },
  ])
})

it('a recording too short to send says so in the bar', async () => {
  const view = renderSolid(() => <TalkBar />)
  await capture.press(voiceSink)?.started
  await capture.take(voiceSink)!.release()
  flush()
  expect(view.querySelector('[data-voice-talk]')?.textContent).toContain('Too short')
})
