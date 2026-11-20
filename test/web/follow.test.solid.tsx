/** @jsxImportSource @solidjs/web */
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

it('lets the reader leave with the wheel, a key or a drag, and come back with one key press', async () => {
  const { scroll, view, pinned, layout } = transcript(5000)
  scroll.dispatchEvent(new WheelEvent('wheel', { deltaY: -200 }))
  view.moveTo(4100)
  view.resize(5400)
  layout()
  expect([pinned.following(), view.top()]).toEqual([false, 4100])

  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'End' }))
  view.moveTo(4400)
  view.moveTo(4700)
  expect(pinned.following()).toBe(true)

  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp' }))
  await Promise.resolve()
  view.moveTo(4000)
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

it('keeps following when a wheel or key has nothing to scroll, or a card took the key', async () => {
  const { scroll, view, pinned } = transcript(600)
  scroll.dispatchEvent(new WheelEvent('wheel', { deltaY: -200 }))
  expect(pinned.following()).toBe(true)

  view.resize(3000)
  view.moveTo(2300)
  const taken = new KeyboardEvent('keydown', { key: 'ArrowUp', cancelable: true })
  taken.preventDefault()
  window.dispatchEvent(taken)
  await Promise.resolve()
  expect(pinned.following()).toBe(true)

  window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', shiftKey: true }))
  await Promise.resolve()
  expect(pinned.following()).toBe(false)
  view.moveTo(2298)
  view.moveTo(2299)
  view.moveTo(2300)
  expect(pinned.following()).toBe(true)
})
