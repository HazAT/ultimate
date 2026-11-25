import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createTalk } from '../../talk.ts'

const chord = { code: 'Space', ctrlKey: true, shiftKey: true }
const key = (init: Partial<KeyboardEvent>) => ({ repeat: false, key: '', ...init }) as KeyboardEvent
const pointer = () => ({ preventDefault() {} }) as PointerEvent

function setup(mode: 'hold' | 'tap', over = { cancel: false }) {
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
    cancel: async () => {
      calls.push('cancel')
      recording = false
    },
    overCancel: () => over.cancel,
    matches: (event) => event.code === 'Space' && event.ctrlKey && event.shiftKey,
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
  talk.pointer.onPointerUp(pointer())
  await vi.runAllTimersAsync()
  expect(calls).toEqual(['press', 'release', 'press'])
  talk.pointer.onPointerDown(pointer())
  talk.pointer.onPointerLeave(pointer())
  await vi.runAllTimersAsync()
  expect(calls).toEqual(['press', 'release', 'press', 'release'])
})

it('a pointer cancelled by the permission prompt lets go once in hold mode and keeps recording in tap mode', async () => {
  const hold = setup('hold')
  hold.talk.pointer.onPointerDown(pointer())
  hold.talk.pointer.onPointerCancel(pointer())
  hold.talk.pointer.onPointerUp(pointer())
  await vi.runAllTimersAsync()
  expect(hold.calls).toEqual(['press', 'release'])

  const tap = setup('tap')
  tap.talk.pointer.onPointerDown(pointer())
  tap.talk.pointer.onPointerCancel(pointer())
  await vi.runAllTimersAsync()
  expect(tap.calls).toEqual(['press'])
  tap.talk.pointer.onPointerDown(pointer())
  await vi.runAllTimersAsync()
  expect(tap.calls).toEqual(['press', 'release'])
})

it('cancel ends only a recording: tap starts fresh after it, a hold lets go without sending', async () => {
  const tap = setup('tap')
  expect(tap.talk.cancel()).toBe(false)
  tap.talk.keyDown(key(chord))
  await vi.runAllTimersAsync()
  expect(tap.talk.cancel()).toBe(true)
  tap.talk.keyDown(key(chord))
  await vi.runAllTimersAsync()
  expect(tap.calls).toEqual(['press', 'cancel', 'press'])

  const hold = setup('hold')
  hold.talk.keyDown(key(chord))
  await vi.runAllTimersAsync()
  hold.talk.keyUp(key({ ...chord, key: ' ' }))
  expect(hold.talk.cancel()).toBe(true)
  hold.talk.pointer.onPointerDown(pointer())
  await vi.runAllTimersAsync()
  hold.talk.keyUp(key({ ...chord, key: ' ' }))
  await vi.runAllTimersAsync()
  expect(hold.calls).toEqual(['press', 'cancel', 'press'])
})

it('a held pointer let go over the cancel button cancels instead of sending', async () => {
  const over = { cancel: false }
  const { talk, calls } = setup('hold', over)
  talk.pointer.onPointerDown(pointer())
  await vi.runAllTimersAsync()
  over.cancel = true
  talk.pointer.onPointerLeave(pointer())
  talk.pointer.onPointerUp(pointer())
  await vi.runAllTimersAsync()
  expect(calls).toEqual(['press', 'cancel'])
})

it('hold mode: pressing records and letting go sends', async () => {
  const { talk, calls } = setup('hold')
  talk.pointer.onPointerDown(pointer())
  talk.pointer.onPointerUp(pointer())
  talk.keyDown(key(chord))
  talk.keyDown(key({ ...chord, repeat: true }))
  talk.keyUp(key({ ...chord, key: ' ' }))
  await vi.runAllTimersAsync()
  expect(calls).toEqual(['press', 'release', 'press', 'release'])
})
