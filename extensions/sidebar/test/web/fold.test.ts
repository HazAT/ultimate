import { expect, it } from 'vitest'
import { foldLines } from '../../fold.web.ts'
import type { FoldLine } from '../../fold.web.ts'

const tree: Record<number, number[]> = {
  1: [10, 20, 30, 40, 50],
  10: [11, 12],
  20: [21],
  40: [41, 42],
  50: [51],
}
const children = (id: number) => tree[id]
const show = (lines: FoldLine[]) =>
  lines.map((line) =>
    line.kind === 'earlier'
      ? `0:earlier ${line.count}${line.open ? ' open' : ''}`
      : `${line.depth}:${line.id}${line.fold ? ` +${line.fold.count}${line.fold.open ? ' open' : ''}` : ''}`,
  )

it('folds finished rounds into one earlier line and their children into their rows', () => {
  expect(show(foldLines(1, children, () => true, new Set()))).toEqual([
    '0:earlier 3',
    '0:40 +2',
    '0:50 +1',
  ])
})

it('keeps running and failed rows, and the rows above them, visible', () => {
  const quiet = (id: number) => id !== 21 && id !== 42
  expect(show(foldLines(1, children, quiet, new Set()))).toEqual([
    '0:10 +2',
    '0:20',
    '1:21',
    '0:30',
    '0:40',
    '1:41',
    '1:42',
    '0:50 +1',
  ])
})

it('shows every child of an opened row, without an earlier line', () => {
  const nested = (id: number) => ({ 1: [10], 10: [11, 12, 13, 14] })[id]
  expect(show(foldLines(1, nested, () => true, new Set(['10'])))).toEqual([
    '0:10 +4 open',
    '1:11',
    '1:12',
    '1:13',
    '1:14',
  ])
})

it('opens the earlier line and one row on their own keys', () => {
  expect(show(foldLines(1, children, () => true, new Set(['earlier:1', '10'])))).toEqual([
    '0:earlier 3 open',
    '0:10 +2 open',
    '1:11',
    '1:12',
    '0:20 +1',
    '0:30',
    '0:40 +2',
    '0:50 +1',
  ])
})
