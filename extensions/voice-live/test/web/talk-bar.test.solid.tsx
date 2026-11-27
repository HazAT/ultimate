import { createSignal, flush, Show } from 'solid-js'
import { beforeEach, expect, it, vi } from 'vitest'
import { parseConversationId } from '../../../../lib/ids.shared.ts'
import { serverEndedSession } from './session.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { capture } from '../../../dictation/ui.solid.tsx'
import { composeIn, dock, settleTranscripts, voiceSink } from '../../dock.solid.tsx'
import { TalkBar } from '../../talk.solid.tsx'

const harness = vi.hoisted(() => ({
  calls: [] as { name: string; who?: string }[],
}))
vi.mock('@/sdk/solid', async (original) => {
  const { createSignal: signal } = await import('solid-js')
  const real = await original<typeof import('@/sdk/solid')>()
  const [dictation, setDictation] = signal({
    talk: 'hold',
    shortcut: 'mod+shift+space',
    cues: true,
  })
  return {
    ...real,
    useAction: () => ({ data: dictation, refetch: async () => dictation() }),
    api: {
      action: (ref: { name: string }, args: unknown, call: { who?: string } = {}) => {
        harness.calls.push({ name: ref.name, who: call.who })
        if (ref.name === 'setSettings')
          setDictation((current) => ({ ...current, ...(args as object) }))
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
      signal<unknown>(key === 'ext.voice-live.cues' ? false : initial),
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
  await serverEndedSession(composeIn)
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
  window.dispatchEvent(touch('pointerup'))
  await vi.waitFor(() => expect(capture.talking(voiceSink)).toBe(false))
  settleTranscripts({ transcripts: { 'rec-1': 'hello' } }, parseConversationId(40))
  await vi.waitFor(() => expect(harness.calls.map((call) => call.name)).toContain('turn'))
})

it('a second finger pressing and lifting on the bar leaves the first finger\u2019s recording running', async () => {
  const view = renderSolid(() => <TalkBar />)
  const bar = () => view.querySelector('[data-voice-talk]')!
  bar().dispatchEvent(touch('pointerdown'))
  await vi.waitFor(() => expect(capture.capturing(voiceSink)).toBe(true))
  speak()
  bar().dispatchEvent(touch('pointerdown', 2))
  window.dispatchEvent(touch('pointerup', 2))
  expect(capture.talking(voiceSink)).toBe(true)
  expect(harness.calls.map((call) => call.name)).not.toContain('record')
  window.dispatchEvent(touch('pointerup'))
  await vi.waitFor(() => expect(capture.talking(voiceSink)).toBe(false))
})

it('in Tap mode a touch while another finger is down is ignored, and the next tap sends once', async () => {
  const { setTalkMode } = await import('../../../dictation/routing.solid.tsx')
  setTalkMode('tap')
  const view = renderSolid(() => <TalkBar />)
  const bar = () => view.querySelector('[data-voice-talk]')!
  bar().dispatchEvent(touch('pointerdown'))
  await vi.waitFor(() => expect(capture.capturing(voiceSink)).toBe(true))
  speak()
  bar().dispatchEvent(touch('pointerdown', 2))
  window.dispatchEvent(touch('pointerup', 2))
  window.dispatchEvent(touch('pointerup'))
  expect(capture.talking(voiceSink)).toBe(true)
  bar().dispatchEvent(touch('pointerdown', 3))
  bar().dispatchEvent(touch('pointerdown', 4))
  window.dispatchEvent(touch('pointerup', 4))
  window.dispatchEvent(touch('pointerup', 3))
  await vi.waitFor(() => expect(capture.talking(voiceSink)).toBe(false))
  settleTranscripts({ transcripts: { 'rec-1': 'hello' } }, parseConversationId(40))
  await vi.waitFor(() => expect(harness.calls.map((call) => call.name)).toContain('turn'))
  expect(harness.calls.filter((call) => call.name === 'record')).toHaveLength(1)
  expect(capture.talking(voiceSink)).toBe(false)
  setTalkMode('hold')
})

it('a take started in the main box is sent from the sheet\u2019s bar after the main one unmounts', async () => {
  const [inSheet, setInSheet] = createSignal(false)
  const view = renderSolid(() => (
    <Show when={inSheet()} fallback={<TalkBar onTalk={() => setInSheet(true)} />}>
      <TalkBar />
    </Show>
  ))
  ;(view.querySelector('[data-voice-talk]') as HTMLElement).click()
  await vi.waitFor(() => expect(capture.capturing(voiceSink)).toBe(true))
  speak()
  ;(view.querySelector('[data-voice-talk]') as HTMLElement).click()
  await vi.waitFor(() => expect(capture.talking(voiceSink)).toBe(false))
  settleTranscripts({ transcripts: { 'rec-1': 'hello' } }, parseConversationId(40))
  await vi.waitFor(() => expect(harness.calls.map((call) => call.name)).toContain('turn'))
})

it('a take is sent as whoever started it, even when someone else starts the next take before it is sent', async () => {
  const { writingAs } = await import('@/sdk/solid')
  await writingAs('agent', () => capture.press(voiceSink))?.started
  speak()
  const released = capture.take(voiceSink)!.release()
  await vi.waitFor(() => expect(capture.talking(voiceSink)).toBe(false))
  const next = writingAs('person', () => capture.press(voiceSink))
  await vi.waitFor(() => expect(harness.calls.map((call) => call.name)).toContain('record'))
  settleTranscripts({ transcripts: { 'rec-1': 'hello' } }, parseConversationId(40))
  await released
  await next?.cancel()
  const writes = harness.calls.filter((call) => call.name === 'record' || call.name === 'turn')
  expect(writes).toEqual([
    { name: 'record', who: 'agent' },
    { name: 'turn', who: 'agent' },
  ])
})

it('a cut-in whose mic fails shows the error in the bar, not the pending reply\u2019s Thinking', () => {
  const view = renderSolid(() => <TalkBar />)
  dock.setPhase('thinking')
  dock.setStatus('Thinking\u2026')
  dock.setError('Microphone access is blocked')
  flush()
  expect(view.querySelector('[data-voice-talk]')?.textContent).toContain(
    'Microphone access is blocked',
  )
  dock.setError(undefined)
  dock.setPhase('idle')
  dock.setStatus(undefined)
})

it('a recording the shortcut started shows its waveform in the bar but no cancel the bar cannot act on', async () => {
  const view = renderSolid(() => <TalkBar />)
  await capture.press(voiceSink)?.started
  flush()
  expect(view.querySelector('[data-voice-talk] canvas')).not.toBeNull()
  expect(view.querySelector('[data-voice-talk-cancel]')).toBeNull()
  await capture.take(voiceSink)!.cancel()
})

it('a recording too short to send says so in the bar', async () => {
  const view = renderSolid(() => <TalkBar />)
  await capture.press(voiceSink)?.started
  await capture.take(voiceSink)!.release()
  flush()
  expect(view.querySelector('[data-voice-talk]')?.textContent).toContain('Too short')
})
