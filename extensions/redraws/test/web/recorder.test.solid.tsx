/** @jsxImportSource @solidjs/web */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { metrics, record } from '../../recorder.ts'

beforeEach(() => {
  vi.stubGlobal(
    'PerformanceObserver',
    Object.assign(
      class {
        observe() {}
        disconnect() {}
      },
      { supportedEntryTypes: [] },
    ),
  )
  document.body.innerHTML =
    '<div role="log"><p>one</p><p>two</p></div><footer data-ui="status-line"><span>3</span></footer><div data-redraws-ignore><span>chip</span></div>'
})
afterEach(() => vi.unstubAllGlobals())

const settle = () => new Promise<void>((resolve) => queueMicrotask(resolve))

it('coalesces a frame of writes into one flash per element and counts them by area', async () => {
  const frames: (() => void)[] = []
  const flashed: Element[] = []
  const stop = record({
    root: document.body,
    frame: (paint) => frames.push(paint),
    flash: (element) => flashed.push(element),
  })
  const [first, second] = document.querySelectorAll('p')
  first.firstChild!.textContent = 'one more'
  first.firstChild!.textContent = 'one more still'
  second.append(' too')
  document.querySelector('footer span')!.textContent = '4'
  document.querySelector('[data-redraws-ignore] span')!.textContent = 'chip 2'
  await settle()

  expect(frames).toHaveLength(1)
  frames[0]()
  expect(flashed).toEqual([first, second, document.querySelector('footer span')])
  expect(metrics.get()).toMatchObject({
    frames: 1,
    busiestFrame: 3,
    writes: { transcript: 2, 'status line': 1 },
  })

  stop()
  first.textContent = 'after stop'
  await settle()
  expect(frames).toHaveLength(1)
})
