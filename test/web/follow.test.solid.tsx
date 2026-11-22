import { afterEach, expect, it, vi } from 'vitest'
import { follow } from '../../web/src/app/follow.ts'

const observers: (() => void)[] = []
const disposers: (() => void)[] = []
vi.stubGlobal(
  'ResizeObserver',
  class {
    constructor(callback: () => void) {
      observers.push(callback)
    }
    observe() {}
    disconnect() {}
  },
)
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  observers.length = 0
  document.body.replaceChildren()
})

function scroller(element: HTMLElement, viewport: number, height: number) {
  let top = 0
  let scrollHeight = height
  element.style.overflowY = 'auto'
  Object.defineProperties(element, {
    clientHeight: { value: viewport },
    scrollHeight: { get: () => scrollHeight },
    scrollTop: {
      get: () => top,
      set: (value: number) => {
        top = Math.max(0, Math.min(value, scrollHeight - viewport))
      },
    },
  })
  return {
    resize: (next: number) => {
      scrollHeight = next
      top = Math.min(top, scrollHeight - viewport)
    },
    moveTo: (next: number) => {
      top = next
      element.dispatchEvent(new Event('scroll'))
    },
    top: () => top,
  }
}

function transcript(height: number) {
  const scroll = document.createElement('div')
  const content = document.createElement('div')
  const output = document.createElement('pre')
  content.append(output)
  scroll.append(content)
  document.body.append(scroll)
  const view = scroller(scroll, 700, height)
  const pinned = follow(scroll, content, () => {})
  disposers.push(pinned.dispose)
  const layout = () => observers.forEach((observe) => observe())
  return { scroll, output, view, pinned, layout }
}

it('stays at the bottom when rows settle after the view shows, even after a click', () => {
  const { scroll, view, pinned, layout } = transcript(7174)
  expect(view.top()).toBe(6474)
  scroll.dispatchEvent(new PointerEvent('pointerdown'))
  window.dispatchEvent(new PointerEvent('pointerup'))
  // Rows settle; the browser anchors the view 46 px up and reports the scroll before the follow sees the resize.
  view.resize(7207)
  view.moveTo(6428)
  layout()
  expect(pinned.following()).toBe(true)
  expect(view.top()).toBe(6507)
})

it('lets the reader leave with the wheel, a key or a drag, and come back with one key press', () => {
  const { scroll, view, pinned, layout } = transcript(5000)
  scroll.dispatchEvent(new WheelEvent('wheel', { deltaY: -200 }))
  view.moveTo(4100)
  view.resize(5400)
  layout()
  expect([pinned.following(), view.top()]).toEqual([false, 4100])

  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'End' }))
  view.moveTo(4400)
  view.moveTo(4700)
  scroll.dispatchEvent(new Event('scrollend'))
  expect(pinned.following()).toBe(true)

  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }))
  view.moveTo(4000)
  scroll.dispatchEvent(new Event('scrollend'))
  view.resize(5600)
  layout()
  expect([pinned.following(), view.top()]).toEqual([false, 4000])
  view.moveTo(4900)
  expect(pinned.following()).toBe(true)

  scroll.dispatchEvent(new PointerEvent('pointerdown'))
  view.moveTo(4000)
  window.dispatchEvent(new PointerEvent('pointercancel'))
  expect(pinned.following()).toBe(false)
})

it('leaves on a wheel up over a tool output at its top, which scrolls the transcript', () => {
  const { output, view, pinned } = transcript(5000)
  const inner = scroller(output, 300, 2000)
  inner.moveTo(500)
  output.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, bubbles: true }))
  expect(pinned.following()).toBe(true)
  inner.moveTo(0)
  output.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, bubbles: true }))
  expect(pinned.following()).toBe(false)
  expect(view.top()).toBe(4300)
})

it('keeps following when a wheel has nothing to scroll, a card took the key, or a button pressed Space', () => {
  const { scroll, view, pinned, layout } = transcript(600)
  scroll.dispatchEvent(new WheelEvent('wheel', { deltaY: -200 }))
  expect(pinned.following()).toBe(true)

  view.resize(3000)
  layout()
  const card = (event: KeyboardEvent) => event.preventDefault()
  window.addEventListener('keydown', card)
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', cancelable: true }))
  view.moveTo(2250)
  scroll.dispatchEvent(new Event('scrollend'))
  window.removeEventListener('keydown', card)
  view.resize(3100)
  layout()
  expect([pinned.following(), view.top()]).toEqual([true, 2400])

  const button = document.createElement('button')
  document.body.append(button)
  button.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', shiftKey: true, bubbles: true }))
  view.moveTo(2300)
  scroll.dispatchEvent(new Event('scrollend'))
  expect(pinned.following()).toBe(true)

  document.body.dispatchEvent(
    new KeyboardEvent('keydown', { key: ' ', shiftKey: true, bubbles: true }),
  )
  view.moveTo(1800)
  expect(pinned.following()).toBe(false)
  scroll.dispatchEvent(new Event('scrollend'))
  view.moveTo(2498)
  view.moveTo(2499)
  view.moveTo(2500)
  expect(pinned.following()).toBe(true)
})

it('takes PageUp on a focused control as reading, and forgets an up key that moved nothing', () => {
  const { scroll, view, pinned, layout } = transcript(5000)
  vi.useFakeTimers()
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }))
  window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowUp' }))
  vi.advanceTimersByTime(240)
  const copy = document.createElement('button')
  const toggle = document.createElement('input')
  toggle.type = 'checkbox'
  document.body.append(copy, toggle)
  copy.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }))
  vi.advanceTimersByTime(20)
  view.moveTo(3800)
  expect(pinned.following()).toBe(false)
  window.dispatchEvent(new KeyboardEvent('keyup', { key: 'PageUp' }))
  scroll.dispatchEvent(new Event('scrollend'))

  view.moveTo(4300)
  expect(pinned.following()).toBe(true)
  toggle.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }))
  view.moveTo(3900)
  expect(pinned.following()).toBe(false)
  scroll.dispatchEvent(new Event('scrollend'))

  view.moveTo(4300)
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home' }))
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift' }))
  window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Home' }))
  vi.advanceTimersByTime(200)
  window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift' }))
  vi.advanceTimersByTime(100)
  vi.useRealTimers()
  view.resize(5050)
  view.moveTo(4250)
  layout()
  expect([pinned.following(), view.top()]).toEqual([true, 4350])
})

it('leaves keys a native control takes to it', () => {
  const { view, pinned, layout } = transcript(5000)
  const range = document.createElement('input')
  range.type = 'range'
  document.body.append(range)
  range.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
  view.resize(view.top() + 760)
  view.moveTo(view.top() - 40)
  layout()
  expect(pinned.following()).toBe(true)
})
