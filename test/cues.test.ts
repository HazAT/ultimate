import { afterEach, expect, it, vi } from 'vitest'
import { startCue, stopCue } from '../lib/cues.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

it('plays nothing and never throws where the browser has no Web Audio', () => {
  vi.stubGlobal('AudioContext', undefined)
  expect(() => (startCue(), stopCue())).not.toThrow()
})
