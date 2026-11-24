import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createTalk } from '../../talk.ts'

const chord = { code: 'Space', ctrlKey: true, shiftKey: true }
const key = (init: Partial<KeyboardEvent>) => ({ repeat: false, key: '', ...init }) as KeyboardEvent
const pointer = () => ({ preventDefault() {} }) as PointerEvent

function setup(mode: 'hold' | 'tap') {
  const calls: string[] = []
  let recording = false
  const talk = createTalk({
    tap: () => mode === 'tap',
    talking: () => recording,
    press: async () => {
      calls.push('press')
      recording = true
    },
    release: async () => {
      calls.push('release')
      recording = false
    },
    matches: (event) => event.code === 'Space' && event.ctrlKey && event.shiftKey,
    wake: () => undefined,
  })
  return { talk, calls }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

it('tap mode: a first tap starts, a second tap stops and sends, autorepeat is ignored', async () => {
  const { talk, calls } = setup('tap')
  expect(talk.keyDown(key(chord))).toBe(true)
  await vi.runAllTimersAsync()
  expect(talk.keyDown(key({ ...chord, repeat: true }))).toBe(true)
  expect(talk.keyDown(key({ ...chord, repeat: true }))).toBe(true)
  talk.keyUp(key({ ...chord, key: ' ' }))
  await vi.runAllTimersAsync()
  expect(calls).toEqual(['press'])

  talk.keyUp(key({ ...chord, key: ' ' }))
  talk.keyDown(key(chord))
  await Promise.resolve()
  expect(calls).toEqual(['press', 'release'])

  talk.pointer.onPointerDown(pointer())
  talk.pointer.onPointerUp()
  await vi.runAllTimersAsync()
  expect(calls).toEqual(['press', 'release', 'press'])
  talk.pointer.onPointerDown(pointer())
  talk.pointer.onPointerLeave()
  await vi.runAllTimersAsync()
  expect(calls).toEqual(['press', 'release', 'press', 'release'])
})

it('hold mode: pressing records and letting go sends', async () => {
  const { talk, calls } = setup('hold')
  talk.pointer.onPointerDown(pointer())
  talk.pointer.onPointerUp()
  talk.keyDown(key(chord))
  talk.keyDown(key({ ...chord, repeat: true }))
  talk.keyUp(key({ ...chord, key: ' ' }))
  await vi.runAllTimersAsync()
  expect(calls).toEqual(['press', 'release', 'press', 'release'])
})
