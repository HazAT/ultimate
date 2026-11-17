import type { ConversationId } from '@earendil-works/pi-durable'

import type { Lane, LaneCall, LaneLink, LaneRun } from './refs.ts'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

export const windows = {
  '30m': { ms: 30 * MINUTE, step: 5 * MINUTE },
  '2h': { ms: 2 * HOUR, step: 20 * MINUTE },
  '24h': { ms: 24 * HOUR, step: 4 * HOUR },
} as const
export type WindowName = keyof typeof windows

export function ago(ms: number) {
  const minutes = Math.round(ms / MINUTE)
  if (minutes < 60) return `-${minutes}m`
  const hours = Math.floor(minutes / 60)
  return minutes % 60 ? `-${hours}h${minutes % 60}m` : `-${hours}h`
}

type WindowWidthFraction = number

export function ticks(window: WindowName) {
  const { ms, step } = windows[window]
  const found: { at: WindowWidthFraction; label: string }[] = []
  for (let before = ms - step; before > 0; before -= step)
    found.push({ at: 1 - before / ms, label: ago(before) })
  found.push({ at: 1, label: 'now' })
  return found
}

const clampToWindowFraction = (value: number) => Math.min(1, Math.max(0, value))

export const position = (
  atEpochMs: number,
  sinceEpochMs: number,
  nowEpochMs: number,
): WindowWidthFraction =>
  clampToWindowFraction((atEpochMs - sinceEpochMs) / (nowEpochMs - sinceEpochMs))

export function block(run: LaneRun, since: number, now: number) {
  const start = Date.parse(run.start)
  const end = run.end === undefined ? now : Date.parse(run.end)
  if (end < since || start > now) return undefined
  const left = position(start, since, now)
  return { left, width: position(end, since, now) - left }
}

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

export const duration = (run: LaneRun, now: number) =>
  (run.end === undefined ? now : Date.parse(run.end)) - Date.parse(run.start)

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

export const FINISHED_CHILD_FOLD_THRESHOLD = 3

const startOf = (lane: Lane) =>
  lane.spawn ? Date.parse(lane.spawn.at) : lane.runs[0] ? Date.parse(lane.runs[0].start) : 0

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

  const subtreeHasOpenRun = (lane: Lane) => {
    const visitedForCycleDetection = new Set<number>()
    const below = (item: Lane): boolean => {
      if (item.runs.length > 0 && item.runs.at(-1)?.end === undefined) return true
      if (visitedForCycleDetection.has(item.conversation)) return false
      visitedForCycleDetection.add(item.conversation)
      return (children.get(item.conversation) ?? []).some(below)
    }
    return below(lane)
  }
  const rows: TreeRow[] = []
  const placedOrFoldedConversations = new Set<number>()

  const markFoldedSubtreePlaced = (lane: Lane): void => {
    if (placedOrFoldedConversations.has(lane.conversation)) return
    placedOrFoldedConversations.add(lane.conversation)
    for (const child of children.get(lane.conversation) ?? []) markFoldedSubtreePlaced(child)
  }
  const visit = (lane: Lane, depth: number, last: boolean, through: boolean[]) => {
    if (placedOrFoldedConversations.has(lane.conversation)) return
    placedOrFoldedConversations.add(lane.conversation)
    rows.push({ kind: 'lane', lane, depth, last, through })
    const below = depth === 0 ? [] : [...through, !last]
    const all = children.get(lane.conversation) ?? []
    const finished = all.filter((child) => !subtreeHasOpenRun(child))
    const fold = finished.length > FINISHED_CHILD_FOLD_THRESHOLD && !expanded.has(lane.conversation)
    const shown = fold ? all.filter(subtreeHasOpenRun) : all

    if (fold) for (const child of all) if (!subtreeHasOpenRun(child)) markFoldedSubtreePlaced(child)
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

  for (const lane of lanes)
    if (!placedOrFoldedConversations.has(lane.conversation)) visit(lane, 0, true, [])
  return rows
}

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

export type LinkPath = {
  from: ConversationId
  to: ConversationId
  d: string
  dot: [number, number]
}

export type Frame = { y: ReadonlyMap<number, number>; width: number; since: number; now: number }

const round = (value: number) => Math.round(value * 10) / 10

export function elbow(x1: number, y1: number, x2: number, y2: number) {
  const r = Math.min(6, Math.abs(y2 - y1) / 2, Math.max(0, x2 - x1))
  if (r <= 0) return `M${round(x1)} ${round(y1)}V${round(y2)}`
  const down = y2 > y1 ? 1 : -1
  return `M${round(x1)} ${round(y1)}V${round(y2 - down * r)}Q${round(x1)} ${round(y2)} ${round(x1 + r)} ${round(y2)}H${round(x2)}`
}

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
