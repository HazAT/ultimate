import { cell } from '../../lib/cell.ts'

export const ignored = 'data-redraws-ignore'

const landmarks: [string, string][] = [
  ['transcript', '[role="log"]'],
  ['composer', '[data-ui="composer"]'],
  ['status line', '[data-ui="status-line"]'],
  ['header', '[data-ui="conversation-header"]'],
  ['title bar', '[data-ui="titlebar"]'],
]

export function areaOf(element: Element, width: number) {
  for (const [area, selector] of landmarks) if (element.closest(selector)) return area
  const aside = element.closest('aside')
  if (aside) return aside.getBoundingClientRect().left < width / 2 ? 'sidebar' : 'panel'
  return 'other'
}

function nameOf(element: Element) {
  const named = element.closest('[data-ui], [aria-label]')
  const where = named?.getAttribute('data-ui') ?? named?.getAttribute('aria-label')
  const own = `${element.tagName.toLowerCase()}${element.classList[0] ? `.${element.classList[0]}` : ''}`
  return where ? `${where} › ${own}` : own
}

export type Metrics = {
  since: number
  writes: Record<string, number>
  frames: number
  busiestFrame: number
  longFrames: number
  worstFrameMs: number
  hot: Record<string, number>
}

const empty = (since: number): Metrics => ({
  since,
  writes: {},
  frames: 0,
  busiestFrame: 0,
  longFrames: 0,
  worstFrameMs: 0,
  hot: {},
})

export const enabled = cell(false)
export const metrics = cell<Metrics>(empty(0))
export const reset = () => metrics.set(empty(performance.now()))

export const byArea = (current: Metrics) =>
  Object.entries(current.writes).toSorted((a, b) => b[1] - a[1])

export function topHot(current: Metrics, count = 5) {
  return Object.entries(current.hot)
    .toSorted((a, b) => b[1] - a[1])
    .slice(0, count)
}

export function record(options: {
  root: Element
  frame: (paint: () => void) => void
  flash: (element: Element) => void
}) {
  reset()
  let pending = new Set<Element>()
  let scheduled = false
  const paint = () => {
    scheduled = false
    const elements = [...pending].filter((element) => element.isConnected)
    pending = new Set()
    if (elements.length === 0) return
    const current = metrics.get()
    const writes = { ...current.writes }
    const hot = { ...current.hot }
    for (const element of elements) {
      const area = areaOf(element, window.innerWidth)
      writes[area] = (writes[area] ?? 0) + 1
      const name = nameOf(element)
      hot[name] = (hot[name] ?? 0) + 1
      options.flash(element)
    }
    metrics.set({
      ...current,
      writes,
      hot,
      frames: current.frames + 1,
      busiestFrame: Math.max(current.busiestFrame, elements.length),
    })
  }
  const note = (node: Node) => {
    const element = node instanceof Element ? node : node.parentElement
    if (!element || element.closest(`[${ignored}]`)) return
    pending.add(element)
  }
  const changes = new MutationObserver((records) => {
    for (const change of records) {
      if (change.type === 'childList' && change.addedNodes.length > 0)
        change.addedNodes.forEach(note)
      else note(change.target)
    }
    if (pending.size > 0 && !scheduled) {
      scheduled = true
      options.frame(paint)
    }
  })
  changes.observe(options.root, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
  })
  const frames = new PerformanceObserver((list) => {
    const current = metrics.get()
    const durations = list.getEntries().map((entry) => entry.duration)
    metrics.set({
      ...current,
      longFrames: current.longFrames + durations.length,
      worstFrameMs: Math.max(current.worstFrameMs, ...durations),
    })
  })
  if (PerformanceObserver.supportedEntryTypes.includes('long-animation-frame'))
    frames.observe({ type: 'long-animation-frame' })
  return () => {
    changes.disconnect()
    frames.disconnect()
  }
}
