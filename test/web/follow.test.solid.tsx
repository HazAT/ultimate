/** @jsxImportSource @solidjs/web */
import { afterEach, expect, it, vi } from 'vitest'
import { follow } from '../../web/src/app/follow.ts'

const observers: (() => void)[] = []
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
  observers.length = 0
})

function transcript(height: number) {
  const scroll = document.createElement('div')
  scroll.style.overflowY = 'auto'
  document.body.append(scroll)
  const content = document.createElement('div')
  scroll.append(content)
  let top = 0
  let scrollHeight = height
  Object.defineProperties(scroll, {
    clientHeight: { value: 700 },
    scrollHeight: { get: () => scrollHeight },
    scrollTop: {
      get: () => top,
      set: (value: number) => {
        top = Math.max(0, Math.min(value, scrollHeight - 700))
      },
    },
  })
  const browser = {
    resize: (next: number) => {
      scrollHeight = next
      top = Math.min(top, scrollHeight - 700)
    },
    moveTo: (next: number) => (top = next),
    scrolled: () => scroll.dispatchEvent(new Event('scroll')),
    layout: () => observers.forEach((observe) => observe()),
  }
  return { scroll, content, browser, top: () => top }
}

it('stays at the bottom when rows change size before the follow sees it', () => {
  const view = transcript(7174)
  const pinned = follow(view.scroll, view.content, () => {})
  expect(view.top()).toBe(6474)
  // Rows settle after mount; the browser anchors the view 46 px up and reports a scroll first.
  view.browser.resize(7207)
  view.browser.moveTo(6428)
  view.browser.scrolled()
  view.browser.layout()
  expect(pinned.following()).toBe(true)
  expect(view.top()).toBe(6507)
})

it('lets the reader scroll up with the wheel and stays there as rows grow', () => {
  const view = transcript(5000)
  const pinned = follow(view.scroll, view.content, () => {})
  view.content.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, bubbles: true }))
  view.browser.moveTo(4100)
  view.browser.scrolled()
  view.browser.resize(5400)
  view.browser.layout()
  expect(pinned.following()).toBe(false)
  expect(view.top()).toBe(4100)
})
