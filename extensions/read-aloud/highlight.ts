import type { PlayerState } from './speech.ts'

export type SpokenText = {
  key?: string
  spans: readonly string[]
  span?: (item: number) => number | undefined
  play?: (span: number) => void
}

type Tracked = { element: () => Element | null | undefined; now?: SpokenText }

type Source = {
  state: { get: () => PlayerState; subscribe: (listener: () => void) => () => void }
  items: () => readonly { at?: number }[]
}

const ANCHOR = 24
const letter = /[\p{L}\p{N}]/gu
const skipped = '.not-prose, .code-block-header, [data-tool-call-id]'

const style = `::highlight(read-aloud) {
  background-color: color-mix(in oklab, var(--brand) 15%, transparent);
  color: var(--foreground);
}
::highlight(read-aloud-hover) {
  background-color: color-mix(in oklab, var(--accent) 70%, transparent);
}`

const lettersOf = (markdown: string) =>
  (
    markdown
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\]\([^)]*\)/g, ']')
      .replace(/^[ \t]*(```|~~~).*$/gm, '')
      .replace(/^[ \t>]*(?:[-*+]|\d+[.)])[ \t]+/gm, '')
      .match(letter) ?? []
  ).join('')

const within = (node: Element, selector: string, root: Element) => {
  const found = node.closest(selector)
  return !!found && found !== root && root.contains(found)
}

function rendered(root: Element) {
  const points: { node: Text; offset: number }[] = []
  let text = ''
  const prose = root.matches('.markdown') || !root.querySelector('.markdown')
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const parent = node.parentElement
    if (!parent || (!prose && !within(parent, '.markdown', root))) continue
    if (within(parent, skipped, root)) continue
    for (const match of node.data.matchAll(letter))
      for (let unit = 0; unit < match[0].length; unit++) {
        text += match[0][unit]
        points.push({ node, offset: match.index + unit })
      }
  }
  return { text, points }
}

function locate(text: string, span: string, from: number) {
  const wanted = lettersOf(span)
  if (!wanted) return undefined
  const start = text.indexOf(wanted.slice(0, ANCHOR), from)
  if (start < 0) return undefined
  if (text.startsWith(wanted, start)) return [start, start + wanted.length] as const
  const tail = wanted.slice(-ANCHOR)
  const last = text.indexOf(tail, start)
  const end =
    last >= 0 && last < start + wanted.length * 2
      ? last + tail.length
      : Math.min(text.length, start + wanted.length)
  return [start, end] as const
}

export function rangesIn(root: Element, spans: readonly string[]) {
  const { text, points } = rendered(root)
  let from = 0
  return spans.map((span) => {
    const at = locate(text, span, from)
    if (!at) return undefined
    from = at[1]
    const range = root.ownerDocument.createRange()
    range.setStart(points[at[0]].node, points[at[0]].offset)
    const end = points[at[1] - 1]
    const after = /^[^\s\p{L}\p{N}]*/u.exec(end.node.data.slice(end.offset + 1))![0]
    range.setEnd(end.node, end.offset + 1 + after.length)
    return range
  })
}

const LINE_GAP = 4
const inside = (rect: DOMRect, x: number, y: number) =>
  x >= rect.left && x <= rect.right && y >= rect.top - LINE_GAP && y <= rect.bottom + LINE_GAP

const attached = (range: Range, root: Element) =>
  [range.startContainer, range.endContainer].every(
    (node) => node.nodeType === Node.TEXT_NODE && root.contains(node),
  )

export function createHighlight(player: Source) {
  const tracked = new Set<Tracked>()
  const cached = new WeakMap<
    Tracked,
    { root: Element; content: string; spans: readonly string[]; ranges: (Range | undefined)[] }
  >()
  let page: { current: Highlight; hover: Highlight; observer: MutationObserver } | undefined
  let shown = ''
  let watched: Element | undefined

  const ranges = (each: Tracked) => {
    const root = each.element()
    const spans = each.now?.spans ?? []
    if (!root?.isConnected || !spans.length) return []
    const content = root.textContent ?? ''
    const known = cached.get(each)
    if (
      known?.root === root &&
      known.content === content &&
      known.spans === spans &&
      known.ranges.every((range) => !range || attached(range, root))
    )
      return known.ranges
    const fresh = rangesIn(root, spans)
    cached.set(each, { root, content, spans, ranges: fresh })
    return fresh
  }

  function show(force = false) {
    if (!page) return
    const now = player.state.get()
    const on = (now.playing || now.paused) && now.index >= 0
    const spoken = on ? [...tracked].find((each) => each.now?.key === now.key) : undefined
    const root = spoken?.element() ?? undefined
    if (root !== watched) {
      page.observer.disconnect()
      watched = root
      if (root) page.observer.observe(root, { subtree: true, childList: true, characterData: true })
      force = true
    }
    const shape = spoken ? `${now.key}\n${now.index}` : ''
    if (!force && shape === shown) return
    shown = shape
    page.current.clear()
    if (!spoken?.now) return
    const { span } = spoken.now
    const at = span ? span(now.index) : player.items()[now.index]?.at
    const range = at === undefined || at < 0 ? undefined : ranges(spoken)[at]
    if (range) page.current.add(range)
  }

  const under = (event: MouseEvent) => {
    const target = event.target
    if (!(target instanceof Element)) return undefined
    const now = player.state.get()
    if (!now.playing && !now.paused && !now.streaming) return undefined
    const candidates = [...tracked].filter((each) => {
      const root = each.element()
      return (
        each.now?.play &&
        each.now.key === now.key &&
        root?.contains(target) &&
        !within(target, `a, button, input, textarea, ${skipped}`, root)
      )
    })
    const spoken = candidates[0]
    if (!spoken?.now?.play) return undefined
    const all = ranges(spoken)
    const span = all.findIndex((range) =>
      [...(range?.getClientRects() ?? [])].some((rect) =>
        inside(rect, event.clientX, event.clientY),
      ),
    )
    return span < 0 ? undefined : { play: spoken.now.play, span, range: all[span]! }
  }

  function start() {
    const current = new Highlight()
    current.priority = 1
    const hover = new Highlight()
    CSS.highlights.set('read-aloud', current)
    CSS.highlights.set('read-aloud-hover', hover)
    const sheet = document.createElement('style')
    sheet.textContent = style
    document.head.append(sheet)
    page = { current, hover, observer: new MutationObserver(() => show(true)) }
    player.state.subscribe(() => show())
    document.addEventListener(
      'pointermove',
      (event) => {
        const hit = under(event)
        if (hit && hover.has(hit.range)) return
        hover.clear()
        if (hit) hover.add(hit.range)
      },
      { passive: true },
    )
    document.addEventListener('click', (event) => {
      if (event.button !== 0 || event.defaultPrevented) return
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      if (getSelection()?.isCollapsed === false) return
      const hit = under(event)
      if (hit) hit.play(hit.span)
    })
  }

  return {
    track(element: () => Element | null | undefined) {
      if (!page) start()
      const each: Tracked = { element }
      tracked.add(each)
      return {
        update(now: SpokenText | undefined) {
          each.now = now
          show(true)
        },
        dispose() {
          tracked.delete(each)
          show(true)
        },
      }
    },
  }
}
