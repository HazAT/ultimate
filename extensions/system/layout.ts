import type { ConversationId } from '@earendil-works/pi-durable'
/**
 * The Agent Lanes geometry: where a window's ticks and a run's block sit, as fractions of the timeline's width; the
 * lanes as a tree; and the dotted links between them.
 */
import type { Lane, LaneCall, LaneLink, LaneRun } from './refs.ts'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** The windows the user picks from, with the step between their ticks. */
export const windows = {
  '30m': { ms: 30 * MINUTE, step: 5 * MINUTE },
  '2h': { ms: 2 * HOUR, step: 20 * MINUTE },
  '24h': { ms: 24 * HOUR, step: 4 * HOUR },
} as const
export type WindowName = keyof typeof windows

/** `-25m`, `-1h`, `-1h20m`: how long before now. */
export function ago(ms: number) {
  const minutes = Math.round(ms / MINUTE)
  if (minutes < 60) return `-${minutes}m`
  const hours = Math.floor(minutes / 60)
  return minutes % 60 ? `-${hours}h${minutes % 60}m` : `-${hours}h`
}

/** The ticks of a window ending now, oldest first, each at `at` (0 the window's start, 1 now); the last is now. */
export function ticks(window: WindowName) {
  const { ms, step } = windows[window]
  const found: { at: number; label: string }[] = []
  for (let before = ms - step; before > 0; before -= step)
    found.push({ at: 1 - before / ms, label: ago(before) })
  found.push({ at: 1, label: 'now' })
  return found
}

const clamp = (value: number) => Math.min(1, Math.max(0, value))

/** Where time `at` (epoch ms) falls in the window `[since, now]`, clamped to it. */
export const position = (at: number, since: number, now: number) =>
  clamp((at - since) / (now - since))

/**
 * A run's block in the window `[since, now]`: `left` and `width` as fractions; an open run reaches now. Undefined when
 * the run lies wholly outside the window.
 */
export function block(run: LaneRun, since: number, now: number) {
  const start = Date.parse(run.start)
  const end = run.end === undefined ? now : Date.parse(run.end)
  if (end < since || start > now) return undefined
  const left = position(start, since, now)
  return { left, width: position(end, since, now) - left }
}

/**
 * A block's label: the tool at least half of its tool calls are (model calls between them do not count), else how
 * many calls it has.
 */
export function label(calls: readonly LaneCall[], more = 0) {
  const counts = new Map<string, number>()
  let tools = 0
  for (const call of calls)
    if (call.kind === 'tool') {
      tools++
      counts.set(call.name, (counts.get(call.name) ?? 0) + 1)
    }
  const [top] = [...counts].toSorted((a, b) => b[1] - a[1])
  if (top && top[1] * 2 >= tools) return top[0]
  const total = calls.length + more
  return total === 1 ? calls[0].name : `${total} calls`
}

/** A run's length in milliseconds, up to now while it is open. */
export const duration = (run: LaneRun, now: number) =>
  (run.end === undefined ? now : Date.parse(run.end)) - Date.parse(run.start)

/**
 * One row of the lane tree: a lane, or the fold of a parent's finished children. `depth` 0 is a root; `last` whether
 * it is its parent's last row, and `through[i]` whether the guide of depth `i + 1` passes on below it (an ancestor at
 * that depth has later siblings).
 */
export type TreeRow =
  | { kind: 'lane'; lane: Lane; depth: number; last: boolean; through: boolean[] }
  | {
      kind: 'fold'
      parent: ConversationId
      count: number
      depth: number
      last: true
      through: boolean[]
    }

/** Children folded behind a "+N finished" row once a parent has more than this many finished ones. */
export const FOLD = 3

const startOf = (lane: Lane) =>
  lane.spawn ? Date.parse(lane.spawn.at) : lane.runs[0] ? Date.parse(lane.runs[0].start) : 0

/**
 * The lanes as a tree, depth first: roots (lanes whose parent is not listed) in the given order, children in the
 * order they started. A parent with more than `FOLD` finished children (no open run anywhere in their subtree) shows
 * the others and folds the finished ones into one row, unless it is in `expanded`. The `pinned` lane (@ultimate)
 * leads, with its subtree, whatever the activity order.
 */
export function tree(
  lanes: readonly Lane[],
  expanded: ReadonlySet<number> = new Set(),
  pinned?: number,
) {
  const listed = new Set(lanes.map((lane) => lane.conversation))
  const children = new Map<number, Lane[]>()
  const roots: Lane[] = []
  for (const lane of lanes) {
    if (lane.parent === undefined || !listed.has(lane.parent)) roots.push(lane)
    else children.set(lane.parent, [...(children.get(lane.parent) ?? []), lane])
  }
  for (const list of children.values()) list.sort((a, b) => startOf(a) - startOf(b))
  const first = roots.findIndex((lane) => lane.conversation === pinned)
  if (first > 0) roots.unshift(...roots.splice(first, 1))
  /** Whether `lane` or anything below it has an open run; a parent cycle is walked once. */
  const open = (lane: Lane) => {
    const walked = new Set<number>()
    const below = (item: Lane): boolean => {
      if (item.runs.length > 0 && item.runs.at(-1)?.end === undefined) return true
      if (walked.has(item.conversation)) return false
      walked.add(item.conversation)
      return (children.get(item.conversation) ?? []).some(below)
    }
    return below(lane)
  }
  const rows: TreeRow[] = []
  const seen = new Set<number>()
  /** `lane` and everything below it as placed. */
  const mark = (lane: Lane): void => {
    if (seen.has(lane.conversation)) return
    seen.add(lane.conversation)
    for (const child of children.get(lane.conversation) ?? []) mark(child)
  }
  const visit = (lane: Lane, depth: number, last: boolean, through: boolean[]) => {
    // A parent cycle in the data shows each of its lanes once, cut where the walk re-enters it.
    if (seen.has(lane.conversation)) return
    seen.add(lane.conversation)
    rows.push({ kind: 'lane', lane, depth, last, through })
    const below = depth === 0 ? [] : [...through, !last]
    const all = children.get(lane.conversation) ?? []
    const finished = all.filter((child) => !open(child))
    const fold = finished.length > FOLD && !expanded.has(lane.conversation)
    const shown = fold ? all.filter(open) : all
    // Folded lanes are placed too: behind their fold row, not lost to a cycle.
    if (fold) for (const child of all) if (!open(child)) mark(child)
    shown.forEach((child, index) =>
      visit(child, depth + 1, !fold && index === shown.length - 1, below),
    )
    if (fold)
      rows.push({
        kind: 'fold',
        parent: lane.conversation,
        count: finished.length,
        depth: depth + 1,
        last: true,
        through: below,
      })
  }
  for (const root of roots) visit(root, 0, true, [])
  // Lanes only reachable through a cycle have no root: each such cycle starts at its first lane in the given order.
  for (const lane of lanes) if (!seen.has(lane.conversation)) visit(lane, 0, true, [])
  return rows
}

/** Each conversation with the conversations above and below it in the tree: whose chain a hovered lane lights up. */
export function chain(lanes: readonly Lane[], conversation: ConversationId) {
  const parents = new Map(lanes.map((lane) => [lane.conversation, lane.parent]))
  const found = new Set([conversation])
  for (let up = parents.get(conversation); up !== undefined && !found.has(up); up = parents.get(up))
    found.add(up)
  const below = [conversation]
  for (let id = below.pop(); id !== undefined; id = below.pop())
    for (const lane of lanes)
      if (lane.parent === id && !found.has(lane.conversation)) {
        found.add(lane.conversation)
        below.push(lane.conversation)
      }
  return found
}

/** A dotted link in pixels: its SVG path and the dot at its start. */
export type LinkPath = {
  from: ConversationId
  to: ConversationId
  d: string
  dot: [number, number]
}

/** Where things sit on the timeline overlay: a row's vertical centre by conversation, and the overlay's width. */
export type Frame = { y: ReadonlyMap<number, number>; width: number; since: number; now: number }

const round = (value: number) => Math.round(value * 10) / 10

/** From `(x1, y1)` down (or up) to `y2`, then across to `x2` round a soft corner; straight down when `x2` is left of it. */
export function elbow(x1: number, y1: number, x2: number, y2: number) {
  const r = Math.min(6, Math.abs(y2 - y1) / 2, Math.max(0, x2 - x1))
  if (r <= 0) return `M${round(x1)} ${round(y1)}V${round(y2)}`
  const down = y2 > y1 ? 1 : -1
  return `M${round(x1)} ${round(y1)}V${round(y2 - down * r)}Q${round(x1)} ${round(y2)} ${round(x1 + r)} ${round(y2)}H${round(x2)}`
}

/**
 * Spawn links: from the spawning call's moment on the parent's row to the start of the child's first block in the
 * window, for each lane with a spawn whose rows are both shown.
 */
export function links(lanes: readonly Lane[], frame: Frame) {
  const found: (LinkPath & { inferred: boolean })[] = []
  for (const lane of lanes) {
    if (!lane.spawn || lane.parent === undefined) continue
    const y1 = frame.y.get(lane.parent)
    const y2 = frame.y.get(lane.conversation)
    const first = lane.runs.map((run) => block(run, frame.since, frame.now)).find(Boolean)
    if (y1 === undefined || y2 === undefined || !first) continue
    const x1 = position(Date.parse(lane.spawn.at), frame.since, frame.now) * frame.width
    found.push({
      from: lane.parent,
      to: lane.conversation,
      d: elbow(x1, y1, first.left * frame.width, y2),
      dot: [round(x1), round(y1)],
      inferred: lane.spawn.inferred === true,
    })
  }
  return found
}

/** Message links: a vertical dotted line at the moment of sending, from the sender's row to the recipient's. */
export function messageLinks(list: readonly LaneLink[], frame: Frame) {
  const found: LinkPath[] = []
  for (const link of list) {
    const y1 = frame.y.get(link.from)
    const y2 = frame.y.get(link.to)
    const at = Date.parse(link.at)
    if (y1 === undefined || y2 === undefined || at < frame.since || at > frame.now) continue
    const x = round(position(at, frame.since, frame.now) * frame.width)
    found.push({
      from: link.from,
      to: link.to,
      d: `M${x} ${round(y1)}V${round(y2)}`,
      dot: [x, round(y1)],
    })
  }
  return found
}
