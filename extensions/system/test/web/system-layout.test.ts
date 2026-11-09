import { expect, it } from 'vitest'
import {
  ago,
  block,
  chain,
  duration,
  elbow,
  label,
  links,
  messageLinks,
  position,
  ticks,
  tree,
} from '../../layout.ts'
import type { Frame } from '../../layout.ts'
import type { Lane, LaneCall, LaneRun } from '../../refs.ts'

const now = Date.parse('2026-10-19T12:00:00Z')
const since = now - 30 * 60_000
const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString()
const call = (name: string, kind = 'tool', ok = true): LaneCall => ({
  at: at(1),
  ms: 100,
  kind,
  name,
  ok,
  trace: 't',
})
const run = (start: number, end?: number): LaneRun => ({
  start: at(start),
  ...(end === undefined ? {} : { end: at(end) }),
  ok: true,
  calls: [],
})

it('ticks a window every step, oldest first, ending at now', () => {
  const thirty = ticks('30m')
  expect(thirty.map((tick) => tick.label)).toEqual(['-25m', '-20m', '-15m', '-10m', '-5m', 'now'])
  thirty.forEach((tick, index) => expect(tick.at).toBeCloseTo((index + 1) / 6))
  expect(thirty.at(-1)!.at).toBe(1)
  expect(ticks('2h').map((tick) => tick.label)).toEqual([
    '-1h40m',
    '-1h20m',
    '-1h',
    '-40m',
    '-20m',
    'now',
  ])
  expect(ticks('24h').map((tick) => tick.label)).toEqual([
    '-20h',
    '-16h',
    '-12h',
    '-8h',
    '-4h',
    'now',
  ])
  expect(ago(90 * 60_000)).toBe('-1h30m')
})

it('places a finished run by its start and end, and an open one up to now', () => {
  const finished = block(run(15, 12), since, now)!
  expect(finished.left).toBeCloseTo(0.5)
  expect(finished.width).toBeCloseTo(0.1)
  const open = block(run(3), since, now)!
  expect(open.left).toBeCloseTo(0.9)
  expect(open.left + open.width).toBeCloseTo(1)
})

it('clips a run crossing the window start and drops one wholly before it', () => {
  const crossing = block(run(40, 27), since, now)!
  expect(crossing.left).toBe(0)
  expect(crossing.width).toBeCloseTo(0.1)
  expect(block(run(50, 35), since, now)).toBeUndefined()
  expect(position(now + 60_000, since, now)).toBe(1)
})

it('labels a block by its main tool, ignoring model calls, else by its call count', () => {
  const model = call('anthropic/opus', 'model')
  expect(label([model, call('bash'), model, call('bash'), model, call('read')])).toBe('bash')
  expect(label([call('read'), call('edit'), call('bash')])).toBe('3 calls')
  expect(label([call('read'), call('edit'), call('bash')], 4)).toBe('7 calls')
  expect(label([model])).toBe('anthropic/opus')
  expect(label([model, model])).toBe('2 calls')
})

it('measures an open run up to now', () => {
  expect(duration(run(15, 12), now)).toBe(3 * 60_000)
  expect(duration(run(2), now)).toBe(2 * 60_000)
})

/** Lane `conversation` under `parent`, spawned `spawned` minutes ago, with runs from `start` to `end` minutes ago. */
const lane = (
  conversation: number,
  parent: number | undefined,
  spawned: number | undefined,
  ...runs: LaneRun[]
): Lane => ({
  conversation,
  ...(parent === undefined ? {} : { parent }),
  ...(spawned === undefined ? {} : { spawn: { call: `c${conversation}`, at: at(spawned) } }),
  runs,
})

const shape = (rows: ReturnType<typeof tree>) =>
  rows.map((row) =>
    row.kind === 'lane'
      ? `${'  '.repeat(row.depth)}${row.lane.conversation}${row.last ? '.' : ''} ${row.through.map(Number).join('')}`
      : `${'  '.repeat(row.depth)}+${row.count} ${row.through.map(Number).join('')}`,
  )

it('orders lanes depth first, roots as given and children by when they started', () => {
  const lanes = [
    lane(1, undefined, undefined, run(20)),
    // Listed before its earlier sibling: children sort by spawn time, not by the list.
    lane(3, 1, 10, run(9)),
    lane(2, 1, 20, run(19, 15)),
    lane(4, 2, 18, run(17, 16)),
    // Its parent is not listed: a root.
    lane(5, 99, 5, run(4, 2)),
  ]
  expect(shape(tree(lanes))).toEqual(['1. ', '  2 ', '    4. 1', '  3. ', '5. '])
})

it('shows every lane of a parent cycle once instead of dropping it', () => {
  // A self-cycle, and a two-lane cycle with a child hanging off it: none has a listed root.
  const lanes = [
    lane(1, undefined, undefined, run(20)),
    lane(2, 2, 15, run(14)),
    lane(3, 4, 12, run(11)),
    lane(4, 3, 10, run(9)),
    lane(5, 4, 8, run(7)),
  ]
  const shown = tree(lanes).flatMap((row) => (row.kind === 'lane' ? [row.lane.conversation] : []))
  expect(shown.toSorted((a, b) => a - b)).toEqual([1, 2, 3, 4, 5])
  expect(shape(tree(lanes))).toEqual(['1. ', '2. ', '3. ', '  4. ', '    5. 0'])
})

it('handles finished and empty cycles without recursing forever, folding them like any lane', () => {
  const lanes = [
    lane(1, 1, 30, run(29, 28)),
    lane(2, 3, 25, run(24, 23)),
    lane(3, 2, 20, run(19, 18)),
    lane(4, 5, undefined),
    lane(5, 4, undefined),
  ]
  const shown = tree(lanes).flatMap((row) => (row.kind === 'lane' ? [row.lane.conversation] : []))
  expect(shown.toSorted((a, b) => a - b)).toEqual([1, 2, 3, 4, 5])
  // A finished parent cycle with more than three finished children still folds.
  const many = [
    lane(10, 11, 30, run(29, 28)),
    lane(11, 10, 25, run(24, 23)),
    ...[12, 13, 14, 15].map((id) => lane(id, 10, 30 - id, run(29 - id, 20 - id))),
  ]
  expect(tree(many).find((row) => row.kind === 'fold')).toMatchObject({ parent: 10, count: 5 })
})

it('leads with the pinned lane and its subtree, the rest in their given order', () => {
  const lanes = [
    lane(7, undefined, undefined, run(5)),
    lane(1, undefined, undefined, run(20)),
    lane(2, 1, 18, run(17)),
    lane(3, undefined, undefined, run(3)),
  ]
  expect(shape(tree(lanes, new Set(), 1))).toEqual(['1. ', '  2. ', '7. ', '3. '])
  // Unpinned, or pinned to a lane that is not a root, the order is unchanged.
  expect(shape(tree(lanes))).toEqual(['7. ', '1. ', '  2. ', '3. '])
  expect(shape(tree(lanes, new Set(), 2))).toEqual(['7. ', '1. ', '  2. ', '3. '])
})

it('folds more than three finished children behind one row, unless expanded', () => {
  const lanes = [
    lane(1, undefined, undefined, run(25)),
    ...[2, 3, 4, 5].map((id) => lane(id, 1, 30 - id, run(29 - id, 20 - id))),
    // Open: shown; and a finished child with an open grandchild counts as open.
    lane(6, 1, 15, run(14)),
    lane(7, 1, 12, run(11, 10)),
    lane(8, 7, 10, run(9)),
  ]
  expect(shape(tree(lanes))).toEqual(['1. ', '  6 ', '  7 ', '    8. 1', '  +4 '])
  expect(tree(lanes).at(-1)).toMatchObject({ kind: 'fold', parent: 1, count: 4, last: true })
  // Three finished are not enough to fold; expanded shows all in start order.
  expect(shape(tree(lanes.filter((item) => item.conversation !== 5)))).toHaveLength(7)
  expect(shape(tree(lanes, new Set([1])))).toEqual([
    '1. ',
    '  2 ',
    '  3 ',
    '  4 ',
    '  5 ',
    '  6 ',
    '  7. ',
    '    8. 0',
  ])
})

it("lights a lane's ancestors and descendants, not its siblings", () => {
  const lanes = [
    lane(1, undefined, undefined),
    lane(2, 1, 10),
    lane(3, 1, 9),
    lane(4, 2, 8),
    lane(5, 4, 7),
  ]
  expect([...chain(lanes, 2)].toSorted((a, b) => a - b)).toEqual([1, 2, 4, 5])
  expect([...chain(lanes, 3)].toSorted((a, b) => a - b)).toEqual([1, 3])
  expect([...chain(lanes, 5)].toSorted((a, b) => a - b)).toEqual([1, 2, 4, 5])
})

it('draws a spawn link from the spawning moment on the parent row to the first block on the child row', () => {
  const frame: Frame = {
    y: new Map([
      [1, 24],
      [2, 72],
      [3, 120],
    ]),
    width: 600,
    since,
    now,
  }
  const lanes = [
    lane(1, undefined, undefined, run(25)),
    // Spawned at -15m (x 300), first block at -12m (x 360), one row down.
    lane(2, 1, 15, run(12, 10)),
    // Its first run lies before the window: the link goes to the first one inside it.
    { ...lane(3, 1, 40, run(40, 35), run(6, 3)), spawn: { at: at(40), inferred: true as const } },
  ]
  const [two, three] = links(lanes, frame)
  expect(two).toMatchObject({ from: 1, to: 2, dot: [300, 24], inferred: false })
  expect(two.d).toBe('M300 24V66Q300 72 306 72H360')
  // A spawn before the window starts at its left edge.
  expect(three).toMatchObject({ from: 1, to: 3, dot: [0, 24], inferred: true })
  expect(three.d).toBe('M0 24V114Q0 120 6 120H480')
  // A child without a shown row, or without a block in the window, gets no link.
  expect(links(lanes, { ...frame, y: new Map([[1, 24]]) })).toEqual([])
  expect(
    links([lanes[0], lane(4, 1, 20, run(50, 45))], {
      ...frame,
      y: new Map([
        [1, 24],
        [4, 72],
      ]),
    }),
  ).toEqual([])
})

it('bends an elbow only where there is room, else drops straight down', () => {
  expect(elbow(10, 0, 10, 40)).toBe('M10 0V40')
  expect(elbow(10, 0, 5, 40)).toBe('M10 0V40')
  expect(elbow(10, 0, 13, 40)).toBe('M10 0V37Q10 40 13 40H13')
  // Upwards, for a child row above its parent's.
  expect(elbow(0, 40, 100, 0)).toBe('M0 40V6Q0 0 6 0H100')
})

it('draws a message as a vertical line at its moment between the two rows, inside the window only', () => {
  const frame: Frame = {
    y: new Map([
      [1, 24],
      [2, 72],
    ]),
    width: 600,
    since,
    now,
  }
  expect(
    messageLinks(
      [
        { from: 2, to: 1, at: at(6), kind: 'message', call: 'c' },
        { from: 1, to: 2, at: at(40), kind: 'message' },
        { from: 1, to: 9, at: at(5), kind: 'message' },
      ],
      frame,
    ),
  ).toEqual([{ from: 2, to: 1, d: 'M480 72V24', dot: [480, 72] }])
})
