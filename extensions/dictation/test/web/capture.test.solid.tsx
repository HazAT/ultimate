import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createCapture } from '../../capture.ts'

class FakeRecorder extends EventTarget {
  static isTypeSupported = () => true
  mimeType = 'audio/webm'
  start() {}
  stop() {
    this.dispatchEvent(new Event('stop'))
  }
}

beforeEach(() => {
  vi.stubGlobal('isSecureContext', true)
  vi.stubGlobal('MediaRecorder', FakeRecorder)
})
afterEach(() => vi.unstubAllGlobals())

function testCapture() {
  const capture = createCapture(() => true)
  const sink = { recording: vi.fn<() => void>(), finish: async () => {} }
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
  const first = capture.press(sink)
  const cancelled = capture.cancel()
  const second = capture.press(sink)
  await Promise.all([first, cancelled, second])
  expect(capture.talking()).toBe(true)
  expect(capture.capturing()).toBe(true)
  expect(capture.recording()).toBe(true)
  expect(sink.recording).toHaveBeenCalledOnce()
  await capture.cancel()
  expect(capture.recording()).toBe(false)
  await capture.end()
})

it('End skips a queued mic start and releases one already in flight', async () => {
  const { capture, mic, sink, requested } = testCapture()
  const gate = Promise.withResolvers<void>()
  mic.gate = gate.promise
  const first = capture.press(sink)
  await requested
  expect(mic.acquired).toBe(1)
  const cancelled = capture.cancel()
  const retake = capture.press(sink)
  const ended = capture.end()
  mic.gate = undefined
  gate.resolve()
  await Promise.all([ended, first, cancelled, retake])
  expect(mic).toMatchObject({ acquired: 1, live: 0 })
  expect(capture.talking()).toBe(false)
  expect(capture.recording()).toBe(false)
})

it('a mic start that fails after End cannot revive the retake queued behind it', async () => {
  const { capture, mic, sink, requested } = testCapture()
  const refuse = Promise.withResolvers<never>()
  mic.refuse = refuse.promise
  const first = capture.press(sink)
  await requested
  expect(mic.asked).toBe(1)
  const cancelled = capture.cancel()
  const retake = capture.press(sink)
  const ended = capture.end()
  mic.refuse = undefined
  refuse.reject(new DOMException('Permission denied', 'NotAllowedError'))
  await Promise.allSettled([ended, first, cancelled, retake])
  expect(mic).toMatchObject({ acquired: 0, live: 0 })
  expect(capture.talking()).toBe(false)
  await capture.press(sink)
  expect(capture.recording()).toBe(true)
  await capture.cancel()
  await capture.end()
})
