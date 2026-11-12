import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyTheme,
  resolvedTheme,
  storedTheme,
  watchSystemTheme,
} from '../../web/src/sdk/theme.ts'

/** The inline script `index.html` runs before any module paints the first load in its appearance. */
const paint = /<script>\s*(\/\/ Before the app loads[\s\S]*?)<\/script>/.exec(
  readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8'),
)![1]

const storage = new Map<string, string>()
const classes = new Set(['dark'])
const meta = {
  content: '#111112',
  setAttribute: (_name: string, value: string) => {
    meta.content = value
  },
}
/** The device's own appearance, and the listener the page registered on it. */
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

describe('theme preference', () => {
  it('keeps an explicit choice from before System existed', () => {
    storage.set('ultimate.theme', 'light')
    expect(storedTheme()).toBe('light')
    storage.set('ultimate.theme', 'dark')
    expect(storedTheme()).toBe('dark')
  })

  it('follows the device when the browser never chose', () => {
    expect(storedTheme()).toBe('system')
    expect(resolvedTheme('system')).toBe('dark')
    device.dark = false
    expect(resolvedTheme('system')).toBe('light')
  })

  it('paints the device appearance until someone chooses', () => {
    applyTheme('system')
    expect(classes.has('dark')).toBe(true)
    expect(meta.content).toBe('#111112')
    device.dark = false
    applyTheme('system')
    expect(classes.has('dark')).toBe(false)
    expect(meta.content).toBe('#f9fafb')
    expect(storage.get('ultimate.theme')).toBe('system')
  })

  it('paints an explicit choice whatever the device does', () => {
    device.dark = false
    applyTheme('dark')
    expect(classes.has('dark')).toBe(true)
    expect(meta.content).toBe('#111112')
    device.dark = true
    applyTheme('light')
    expect(classes.has('dark')).toBe(false)
    expect(meta.content).toBe('#f9fafb')
  })

  it('switches with the device while the page is open', () => {
    applyTheme('system')
    const stop = watchSystemTheme(() => applyTheme('system'))
    expect(classes.has('dark')).toBe(true)
    device.dark = false
    device.listener!()
    expect(classes.has('dark')).toBe(false)
    stop()
    expect(device.listener).toBeUndefined()
  })
})

describe('the first paint', () => {
  const run = (stored: string | null, dark: boolean) => {
    if (stored) storage.set('ultimate.theme', stored)
    device.dark = dark
    runInNewContext(paint, {
      localStorage: { getItem: (key: string) => storage.get(key) ?? null },
      matchMedia: () => ({ matches: device.dark }),
      document,
    })
    return classes.has('dark')
  }

  it('shows what the app will show, before it loads', () => {
    expect(run(null, true)).toBe(true)
    expect(run(null, false)).toBe(false)
    storage.clear()
    classes.add('dark')
    expect(run('light', true)).toBe(false)
    storage.clear()
    classes.add('dark')
    expect(run('dark', false)).toBe(true)
  })
})
