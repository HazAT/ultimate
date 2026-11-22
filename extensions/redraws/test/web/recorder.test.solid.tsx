/** @jsxImportSource @solidjs/web */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { metrics, record, reset, topHot } from '../../recorder.ts'

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

const delivered = () => new Promise<void>((resolve) => queueMicrotask(resolve))

function start() {
  const frames: (() => void)[] = []
  const flashed: Element[] = []
  const stop = record({
    root: document.body,
    frame: (paint) => frames.push(paint),
    flash: (element) => flashed.push(element),
  })
  return { frames, flashed, stop }
}

it('paints writes from several deliveries once per frame, one flash per element, counted by area', async () => {
  const { frames, flashed, stop } = start()
  const [first, second] = document.querySelectorAll('p')
  first.firstChild!.textContent = 'one more'
  document.querySelector('[data-redraws-ignore] span')!.textContent = 'chip 2'
  await delivered()
  first.firstChild!.textContent = 'one more still'
  second.append(' too')
  document.querySelector('footer span')!.textContent = '4'
  await delivered()

  expect(frames).toHaveLength(1)
  frames[0]()
  expect(flashed).toEqual([first, second, document.querySelector('footer span')])
  expect(metrics.get()).toMatchObject({
    frames: 1,
    busiestFrame: 3,
    writes: { transcript: 2, 'status line': 1 },
  })
  expect(topHot(metrics.get()).map((entry) => entry.writes)).toEqual([1, 1, 1])
  stop()
})

it('drops queued writes on reset and on stop', async () => {
  const { frames, flashed, stop } = start()
  const [first, second] = document.querySelectorAll('p')
  first.textContent = 'queued before reset'
  await delivered()
  second.textContent = 'undelivered before reset'
  reset()
  first.textContent = 'after reset'
  await delivered()
  frames.at(-1)!()
  expect(flashed).toEqual([first])

  first.textContent = 'before stop'
  await delivered()
  stop()
  frames.at(-1)!()
  first.textContent = 'after stop'
  await delivered()
  expect(flashed).toEqual([first])
})
