import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { capture } from '../../../dictation/ui.solid.tsx'
import { dock, sideChatSink } from '../../dock.solid.tsx'

let take: ReturnType<typeof capture.press>
const press = () => {
  take = capture.press(sideChatSink)
  return take?.started
}
const release = () => take!.release()
const talking = () => capture.talking(sideChatSink)

beforeEach(() => vi.stubGlobal('MediaRecorder', Object))
afterEach(() => vi.unstubAllGlobals())

const denyingBrowser = (userAgent: string) => {
  const getUserMedia = vi.fn<() => Promise<MediaStream>>(() =>
    Promise.reject(new DOMException('Permission denied', 'NotAllowedError')),
  )
  vi.stubGlobal('isSecureContext', true)
  vi.stubGlobal('navigator', { userAgent, mediaDevices: { getUserMedia } })
  return getUserMedia
}

it('a press refused before the mic leaves the Side chat panel usable for the next press', async () => {
  vi.stubGlobal('isSecureContext', false)
  await press()
  expect(dock.error()).toBe('Voice needs HTTPS: open Ultimate over its tailnet URL')
  expect(talking()).toBe(false)

  const getUserMedia = denyingBrowser('Mozilla/5.0 (X11; Linux x86_64)')
  await press()
  expect(getUserMedia).toHaveBeenCalledOnce()
  expect(dock.error()).toBe('Microphone access is blocked: allow it in the browser’s site settings')
  expect(talking()).toBe(false)
  await release()
  expect(dock.phase()).not.toBe('sending')
})

it('the Side chat panel names the app’s web view when it denies the mic', async () => {
  denyingBrowser('Mozilla/5.0 (Linux; Android 16; Pixel; wv) AppleWebKit/537.36')
  await press()
  expect(dock.error()).toBe(
    'Microphone denied: this app must declare and grant the microphone to its web view',
  )
  expect(talking()).toBe(false)
  await release()
  expect(dock.phase()).not.toBe('sending')
})
