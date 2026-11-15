import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { applyTheme, storedTheme, watchSystemTheme } from '../../web/src/sdk/theme.ts'

/** The inline script paints before any module loads. */
const paint = /<script>\s*(\/\/ Before the app loads[\s\S]*?)<\/script>/.exec(
  readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8'),
)![1]
const storage = new Map<string, string>()
const classes = new Set<string>()
const meta = {
  content: '#111112',
  setAttribute: (_name: string, value: string) => {
    meta.content = value
  },
}
const device = { dark: true, listener: undefined as (() => void) | undefined }

beforeEach(() => {
  storage.clear()
  classes.clear()
  classes.add('dark')
  meta.content = '#111112'
  device.dark = true
  device.listener = undefined
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  })
  vi.stubGlobal('matchMedia', () => ({
    get matches() {
      return device.dark
    },
    addEventListener: (_: string, listener: () => void) => {
      device.listener = listener
    },
    removeEventListener: () => {
      device.listener = undefined
    },
  }))
  vi.stubGlobal('document', {
    documentElement: {
      classList: {
        remove: (name: string) => classes.delete(name),
        toggle: (name: string, on: boolean) => (on ? classes.add(name) : classes.delete(name)),
      },
    },
    querySelector: () => meta,
  })
})
afterEach(() => vi.unstubAllGlobals())

function expectAppearance(theme: 'light' | 'dark') {
  expect(classes.has('dark')).toBe(theme === 'dark')
  expect(meta.content).toBe(theme === 'dark' ? '#111112' : '#f9fafb')
}

it.each([
  // Stored choice, device darkness, first appearance, appearance after the device switches.
  [null, true, 'dark', 'light'],
  [null, false, 'light', 'dark'],
  ['light', true, 'light', 'light'],
  ['dark', false, 'dark', 'dark'],
] as const)('prepaints and follows %s with device dark=%s', (stored, dark, initial, changed) => {
  if (stored) storage.set('ultimate.theme', stored)
  device.dark = dark
  const preference = storedTheme()
  expect(preference).toBe(stored ?? 'system')
  runInNewContext(paint, { localStorage, matchMedia, document })
  expectAppearance(initial)

  // Check the app's painter independently, starting from the opposite appearance.
  if (initial === 'dark') classes.delete('dark')
  else classes.add('dark')
  meta.content = ''
  applyTheme(preference)
  expectAppearance(initial)
  const stop = watchSystemTheme(() => applyTheme(preference))
  device.dark = !dark
  device.listener!()
  expectAppearance(changed)
  expect(storage.get('ultimate.theme')).toBe(preference)
  stop()
  expect(device.listener).toBeUndefined()
})
