import { settle } from '@ui-sdk/core/testing'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createCapture } from '../../capture.web.ts'

class FakeRecorder extends EventTarget {
  static isTypeSupported = () => true
  static last: FakeRecorder | undefined
  mimeType = 'audio/webm'
  state = 'inactive'
  deferStop = false
  start() {
    FakeRecorder.last = this
    this.state = 'recording'
  }
  stop() {
    this.state = 'inactive'
    if (!this.deferStop) this.deliverStop()
  }
  deliverStop(withAudio = false) {
    this.state = 'inactive'
    if (withAudio)
      this.dispatchEvent(Object.assign(new Event('dataavailable'), { data: new Blob(['audio']) }))
    this.dispatchEvent(new Event('stop'))
  }
}

beforeEach(() => {
  FakeRecorder.last = undefined
  vi.stubGlobal('isSecureContext', true)
  vi.stubGlobal('MediaRecorder', FakeRecorder)
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
})
afterEach(() => vi.unstubAllGlobals())

function testCapture() {
  const capture = createCapture(() => true)
  const sink = {
    recording: vi.fn<() => void>(),
    cancel: vi.fn<() => void>(),
    finish: vi.fn<() => Promise<void>>(async () => {}),
  }
  const requested = Promise.withResolvers<void>()
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
        requested.resolve()
        if (mic.refuse) return mic.refuse
        mic.acquired++
        mic.live++
        const stream = { getTracks: () => [{ stop: () => mic.live-- }] }
        return (mic.gate ?? Promise.resolve()).then(() => stream)
      },
    },
  })
  return { capture, mic, sink, requested: requested.promise }
}

it('a cancel while the mic is still starting lets a fresh press record once it has started', async () => {
  const { capture, sink } = testCapture()
  const first = capture.press(sink)!
  const cancelled = first.cancel()
  const second = capture.press(sink)!
  await Promise.all([first.started, cancelled, second.started])
  expect(capture.talking()).toBe(true)
  expect(capture.capturing()).toBe(true)
  const recorder = FakeRecorder.last!
  expect(recorder.state).toBe('recording')
  expect(sink.recording).toHaveBeenCalledOnce()
  await second.cancel()
  expect(recorder.state).toBe('inactive')
  await capture.end()
})

it('End skips a queued mic start and releases one already in flight', async () => {
  const { capture, mic, sink, requested } = testCapture()
  const gate = Promise.withResolvers<void>()
  mic.gate = gate.promise
  const first = capture.press(sink)!
  await requested
  expect(mic.acquired).toBe(1)
  const cancelled = first.cancel()
  const retake = capture.press(sink)!
  const ended = capture.end()
  mic.gate = undefined
  gate.resolve()
  await Promise.all([ended, first.started, cancelled, retake.started])
  expect(mic).toMatchObject({ acquired: 1, live: 0 })
  expect(capture.talking()).toBe(false)
  expect(FakeRecorder.last?.state).not.toBe('recording')
})

it('a mic start that fails after End cannot revive the retake queued behind it', async () => {
  const { capture, mic, sink, requested } = testCapture()
  const refuse = Promise.withResolvers<never>()
  mic.refuse = refuse.promise
  const first = capture.press(sink)!
  await requested
  expect(mic.asked).toBe(1)
  const cancelled = first.cancel()
  const retake = capture.press(sink)!
  const ended = capture.end()
  mic.refuse = undefined
  refuse.reject(new DOMException('Permission denied', 'NotAllowedError'))
  await Promise.allSettled([ended, first.started, cancelled, retake.started])
  expect(mic).toMatchObject({ acquired: 0, live: 0 })
  expect(capture.talking()).toBe(false)
  const next = capture.press(sink)!
  await next.started
  expect(FakeRecorder.last?.state).toBe('recording')
  await next.cancel()
  await capture.end()
})

it('End discards a released Voice take without disturbing a press in another box', async () => {
  const { capture, sink } = testCapture()
  const session = new AbortController()
  const voice = { ...sink, signal: session.signal }
  const first = capture.press(voice)!
  await first.started
  const recorder = FakeRecorder.last!
  recorder.deferStop = true
  const releasing = first.release()
  const next = capture.press(sink)!
  const ended = capture.end(voice)
  session.abort()
  await ended
  expect(recorder.state).toBe('inactive')
  expect(capture.talking(sink)).toBe(true)
  recorder.deliverStop(true)
  await Promise.all([releasing, next.started])
  expect(voice.finish).not.toHaveBeenCalled()
  expect(capture.talking(sink)).toBe(true)
  expect(capture.capturing(sink)).toBe(true)
  await next.cancel()
  await capture.end()
})

it('settles a take once when the recorder stops on its own and lets the next press record', async () => {
  const { capture, mic, sink } = testCapture()
  const first = capture.press(sink)!
  await first.started
  FakeRecorder.last!.deliverStop(true)
  await settle()
  expect(capture.talking()).toBe(false)
  expect(capture.capturing()).toBe(false)
  expect(mic.live).toBe(0)
  await first.release()
  expect(sink.finish).toHaveBeenCalledOnce()
  expect(sink.cancel).not.toHaveBeenCalled()

  const next = capture.press(sink)!
  await next.started
  expect(capture.capturing(sink)).toBe(true)
  FakeRecorder.last!.deliverStop()
  await settle()
  expect(capture.talking()).toBe(false)
  expect(sink.finish).toHaveBeenCalledOnce()
  expect(sink.cancel).toHaveBeenCalledOnce()
  await capture.end()
})
