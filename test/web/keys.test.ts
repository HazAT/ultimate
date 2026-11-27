import { afterEach, expect, it, vi } from 'vitest'

const event = (values: Partial<KeyboardEvent>) =>
  ({
    key: 'q',
    code: 'KeyK',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...values,
  }) as KeyboardEvent

afterEach(() => vi.unstubAllGlobals())
it.each(['Linux', 'MacIntel'])('normalizes and displays shortcuts on %s', async (platform) => {
  vi.resetModules()
  vi.stubGlobal('navigator', { platform })
  const { chordOf, formatKeys } = await import('../../web/src/sdk/keys.ts')
  expect(formatKeys(' Shift+MOD+K ')).toEqual(
    platform === 'MacIntel' ? ['⌘', '⇧', 'K'] : ['Ctrl', 'Shift', 'K'],
  )
  expect(formatKeys('esc')).toEqual([platform === 'MacIntel' ? 'esc' : 'Esc'])
  expect(
    chordOf(
      event({ shiftKey: true, ctrlKey: platform === 'Linux', metaKey: platform === 'MacIntel' }),
    ),
  ).toBe('mod+shift+k')
  expect(chordOf(event({ code: 'Digit1', key: '!' }))).toBe('1')
  expect(chordOf(event({ code: 'Escape', key: 'Escape' }))).toBe('escape')
  expect(chordOf(event({ code: 'ShiftLeft', key: 'Shift', shiftKey: true }))).toBe('shift')
  expect(chordOf(event({ ctrlKey: true, altKey: true }))).toBe(
    platform === 'MacIntel' ? 'ctrl+alt+k' : 'mod+alt+k',
  )
})
