import { render } from '@solidjs/web'
import { flush } from 'solid-js'
import { afterEach } from 'vitest'

// ui-sdk's testing reference: jsdom does not implement layout or these browser APIs.
HTMLElement.prototype.showPopover = function () {}
HTMLElement.prototype.hidePopover = function () {}
Element.prototype.getAnimations = () => []
Element.prototype.scrollIntoView = function () {}
Element.prototype.checkVisibility = () => true
Element.prototype.getClientRects = () => [] as unknown as DOMRectList
document.elementFromPoint = () => null
document.elementsFromPoint = () => []
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
}
document.head.append(
  Object.assign(document.createElement('style'), {
    textContent: '[popover] { display: block !important }',
  }),
)

Object.assign(globalThis, { __UI_SDK_STRICT__: true })

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) cleanup()
})

export function renderSolid(view: Parameters<typeof render>[0]) {
  const container = document.createElement('div')
  document.body.append(container)
  let dispose: (() => void) | undefined
  cleanups.push(() => {
    try {
      dispose?.()
    } finally {
      container.remove()
    }
  })
  dispose = render(view, container)
  flush()
  return container
}
