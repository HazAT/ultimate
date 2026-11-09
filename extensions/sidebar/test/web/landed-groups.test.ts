import { expect, it } from 'vitest'
import { groupLandings, groupRange } from '../../landings.ts'
import type { Landing } from '../../landings.ts'

const landing = (sha: string, base: string, feature?: string, title?: string): Landing => ({
  type: 'landed',
  entry: Number.parseInt(sha, 16),
  root: 1,
  sha,
  base,
  commits: 1,
  ...(feature && { feature }),
  ...(title && { title }),
})

it('folds every landing of a feature into one row, at its newest landing', () => {
  const groups = groupLandings([
    landing('d', 'c', 'Sidebar'),
    landing('c', 'b', 'Pi Upgrade'),
    landing('b', 'a', 'Sidebar'),
    landing('a', '0', undefined, 'Fix the build'),
  ])
  expect(groups.map((group) => [group.label, group.landings.map((l) => l.sha)])).toEqual([
    ['Sidebar', ['d', 'b']],
    ['Pi Upgrade', ['c']],
    ['Fix the build', ['a']],
  ])
})

it('reviews a group as one range only while its landings follow each other', () => {
  expect(groupRange([landing('c', 'b'), landing('b', 'a')])).toBe('a...c')
  // Another feature landed in between: a range would bring in its commits too.
  expect(groupRange([landing('d', 'c'), landing('b', 'a')])).toBeUndefined()
  expect(groupRange([{ ...landing('b', 'a'), base: undefined }])).toBeUndefined()
})
