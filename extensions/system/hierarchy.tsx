// The lanes as a tree: rows indented under the lane that started them, a dotted overlay linking each spawning call to
// its child's first block, and the chain of a hovered or picked lane lit while the rest dims.
import { useLayoutEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { cn, useConversations } from '@/sdk'
import { Guide, INDENT, LaneRow, ROW_CENTRE, standingName } from './lanes.tsx'
import type { LaneState } from './lanes.tsx'
import { chain, links, messageLinks, tree } from './layout.ts'
import type { Frame, WindowName } from './layout.ts'
import type { Lane, LaneLink } from './refs.ts'

const KEY = 'ultimate.system.expanded'
/** Parents whose finished children the user unfolded, remembered in this browser. */
function useExpanded() {
  const [expanded, setExpanded] = useState<Set<number>>(() => {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]')
      return new Set(Array.isArray(stored) ? stored.filter(Number.isInteger) : [])
    } catch {
      // A hand-edited or foreign value: start folded, the next toggle overwrites it.
      return new Set()
    }
  })
  const toggle = (parent: number) => {
    const next = new Set(expanded)
    if (!next.delete(parent)) next.add(parent)
    localStorage.setItem(KEY, JSON.stringify([...next].slice(-200)))
    setExpanded(next)
  }
  return { expanded, toggle }
}

type Box = { left: number; width: number; y: Map<number, number> }

/**
 * Where the timeline column sits in the list and each lane's centre line: measured when the rows (`rows`, a key of
 * them) change and whenever the list resizes, as it does when a run's calls open.
 */
function useFrame(list: RefObject<HTMLUListElement | null>, rows: string) {
  const [box, setBox] = useState<Box>()
  useLayoutEffect(() => {
    const element = list.current
    if (!element) return undefined
    const measure = () => {
      const timeline = element.querySelector<HTMLElement>('[data-timeline]')
      if (!timeline) return
      const origin = element.getBoundingClientRect()
      const area = timeline.getBoundingClientRect()
      const y = new Map<number, number>()
      for (const row of element.querySelectorAll<HTMLElement>(':scope > [data-lane]'))
        y.set(Number(row.dataset.lane), row.offsetTop + ROW_CENTRE)
      const next = { left: area.left - origin.left, width: area.width, y }
      setBox((previous) => (previous && same(previous, next) ? previous : next))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [list, rows])
  return box
}
const same = (a: Box, b: Box) =>
  a.left === b.left &&
  a.width === b.width &&
  a.y.size === b.y.size &&
  [...a.y].every(([id, at]) => b.y.get(id) === at)

/** The lanes as an indented tree with their spawn and message links. */
export function LaneTree({
  lanes,
  links: messages,
  states,
  window,
  since,
  now,
  onFilter,
}: {
  lanes: Lane[]
  links: LaneLink[]
  states: Map<number, LaneState>
  window: WindowName
  since: number
  now: number
  onFilter: (conversation: number) => void
}) {
  const { expanded, toggle } = useExpanded()
  const [hovered, setHovered] = useState<number>()
  const [picked, setPicked] = useState<number>()
  const list = useRef<HTMLUListElement>(null)
  const summaries = useConversations()
  // @ultimate always leads, with the conversations it started under it.
  const ultimate = lanes.find(
    (lane) =>
      standingName(
        lane,
        summaries.find((item) => item.id === lane.conversation),
      ) === 'ultimate',
  )?.conversation
  const rows = tree(lanes, expanded, ultimate)
  const shown = lanes.filter((lane) => rows.some((row) => row.kind === 'lane' && row.lane === lane))
  const box = useFrame(
    list,
    rows.map((row) => (row.kind === 'lane' ? row.lane.conversation : `+${row.parent}`)).join(),
  )
  const frame: Frame | undefined = box && { y: box.y, width: box.width, since, now }
  const focus = hovered ?? picked
  const lit = focus === undefined ? undefined : chain(lanes, focus)
  const spawns = frame ? links(shown, frame) : []
  const sent =
    frame && focus !== undefined
      ? messageLinks(
          messages.filter((link) => link.from === focus || link.to === focus),
          frame,
        )
      : []
  const on = (from: number, to: number) => !lit || (lit.has(from) && lit.has(to))
  return (
    <ul className="relative" ref={list}>
      {rows.map((row) =>
        row.kind === 'lane' ? (
          <LaneRow
            dimmed={lit !== undefined && !lit.has(row.lane.conversation)}
            key={row.lane.conversation}
            now={now}
            onFilter={() => onFilter(row.lane.conversation)}
            onHover={(hover) => setHovered(hover ? row.lane.conversation : undefined)}
            onPick={(pick) =>
              setPicked((current) =>
                pick
                  ? row.lane.conversation
                  : current === row.lane.conversation
                    ? undefined
                    : current,
              )
            }
            row={row}
            since={since}
            state={states.get(row.lane.conversation) ?? 'idle'}
            window={window}
          />
        ) : (
          <li
            className={cn(
              'relative border-b border-border/50 transition-opacity last:border-b-0',
              lit && !lit.has(row.parent) && 'opacity-40',
            )}
            key={`fold-${row.parent}`}
            style={{ paddingLeft: row.depth * INDENT }}
          >
            <Guide centre={16} row={row} />
            <button
              className="flex h-8 cursor-pointer items-center pl-2 font-mono text-[10.5px] text-muted-foreground/70 hover:text-foreground"
              onClick={() => toggle(row.parent)}
              type="button"
            >
              +{row.count} finished
            </button>
          </li>
        ),
      )}
      {box && (
        <svg
          aria-hidden
          className="pointer-events-none absolute top-0 hidden h-full overflow-visible md:block"
          style={{ left: box.left, width: box.width }}
        >
          {spawns.map((link) => (
            <g
              className={cn(
                'stroke-muted-foreground transition-opacity',
                on(link.from, link.to)
                  ? link.inferred
                    ? 'opacity-30'
                    : 'opacity-55'
                  : 'opacity-15',
              )}
              key={`s${link.to}`}
            >
              <path d={link.d} fill="none" strokeDasharray="1 3" strokeLinecap="round" />
              <circle
                className="fill-muted-foreground stroke-none"
                cx={link.dot[0]}
                cy={link.dot[1]}
                r={2}
              />
            </g>
          ))}
          {sent.map((link, index) => (
            <g className="stroke-brand opacity-45" key={`m${index}`}>
              <path d={link.d} fill="none" strokeDasharray="1 3" strokeLinecap="round" />
              <circle
                className="fill-brand stroke-none"
                cx={link.dot[0]}
                cy={link.dot[1]}
                r={1.5}
              />
            </g>
          ))}
        </svg>
      )}
    </ul>
  )
}
