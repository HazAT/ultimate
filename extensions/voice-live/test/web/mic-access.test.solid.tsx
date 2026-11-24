import { expect, it, vi } from 'vitest'
import { dock, press, release, talking } from '../../dock.solid.tsx'

vi.mock('@/sdk/solid', async () => {
  const { createSignal } = await import('solid-js')
  return {
    api: { action: () => Promise.resolve({}) },
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
vi.stubGlobal('speechSynthesis', { cancel() {}, speak() {} })
vi.stubGlobal('MediaRecorder', Object)

const denyingBrowser = (userAgent: string) => {
  const getUserMedia = vi.fn<() => Promise<MediaStream>>(() =>
    Promise.reject(new DOMException('Permission denied', 'NotAllowedError')),
  )
  vi.stubGlobal('isSecureContext', true)
  vi.stubGlobal('navigator', { userAgent, mediaDevices: { getUserMedia } })
  return getUserMedia
}

it('a press refused before the mic leaves the talk bar usable for the next press', async () => {
  vi.stubGlobal('isSecureContext', false)
  await press()
  expect(dock.error()).toBe('Voice needs HTTPS: open Ultimate over its tailnet URL')
  expect(talking()).toBe(false)

  const getUserMedia = denyingBrowser('Mozilla/5.0 (X11; Linux x86_64)')
  await press()
  expect(getUserMedia).toHaveBeenCalledOnce()
  expect(dock.error()).toBe('Microphone denied: allow it in the browser’s site settings')
  expect(talking()).toBe(false)
  await release()
  expect(dock.phase()).not.toBe('sending')
})

it('names the app’s web view when it denies the mic', async () => {
  denyingBrowser('Mozilla/5.0 (Linux; Android 16; Pixel; wv) AppleWebKit/537.36')
  await press()
  expect(dock.error()).toBe(
    'Microphone denied: this app must declare and grant the microphone to its web view',
  )
  expect(talking()).toBe(false)
})
