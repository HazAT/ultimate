import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createCapture } from '../../capture.web.ts'

beforeEach(() => vi.stubGlobal('MediaRecorder', Object))
afterEach(() => vi.unstubAllGlobals())

const testSink = () => ({
  error: vi.fn<(message: string) => void>(),
  finish: vi.fn<() => Promise<void>>(async () => {}),
})

const denyingBrowser = (userAgent: string) => {
  const getUserMedia = vi.fn<() => Promise<MediaStream>>(() =>
    Promise.reject(new DOMException('Permission denied', 'NotAllowedError')),
  )
  vi.stubGlobal('isSecureContext', true)
  vi.stubGlobal('navigator', { userAgent, mediaDevices: { getUserMedia } })
  return getUserMedia
}

it('a press refused before the mic leaves capture usable for the next press', async () => {
  const capture = createCapture()
  const sink = testSink()
  vi.stubGlobal('isSecureContext', false)
  await capture.press(sink)?.started
  expect(sink.error).toHaveBeenLastCalledWith(
    'Voice needs HTTPS: open Ultimate over its tailnet URL',
  )
  expect(capture.talking()).toBe(false)

  const getUserMedia = denyingBrowser('Mozilla/5.0 (X11; Linux x86_64)')
  const take = capture.press(sink)!
  await take.started
  expect(getUserMedia).toHaveBeenCalledOnce()
  expect(sink.error).toHaveBeenLastCalledWith(
    'Microphone access is blocked: allow it in the browser’s site settings',
  )
  expect(capture.talking()).toBe(false)
  await take.release()
  expect(sink.finish).not.toHaveBeenCalled()
})

it('names the app’s web view when it denies the mic', async () => {
  const capture = createCapture()
  const sink = testSink()
  denyingBrowser('Mozilla/5.0 (Linux; Android 16; Pixel; wv) AppleWebKit/537.36')
  await capture.press(sink)?.started
  expect(sink.error).toHaveBeenLastCalledWith(
    'Microphone denied: this app must declare and grant the microphone to its web view',
  )
  expect(capture.talking()).toBe(false)
})
