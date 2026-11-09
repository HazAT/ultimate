import { expect, it } from 'vitest'
import { workOf } from '../../work.ts'

const branch = 'ultimate/47c790-12'

it('shows commits ahead of the target as a review of the branch', () => {
  expect(workOf(12, branch, { unlanded: 3, uncommitted: 0 })).toEqual({
    commits: { count: 3, spec: `branch:${branch}` },
  })
})

it('shows uncommitted edits as a review of that worktree', () => {
  expect(workOf(12, branch, { unlanded: 0, uncommitted: 2 })).toEqual({
    edits: { count: 2, spec: 'uncommitted:12' },
  })
  expect(workOf(12, branch, { unlanded: 1, uncommitted: 4 })).toEqual({
    commits: { count: 1, spec: `branch:${branch}` },
    edits: { count: 4, spec: 'uncommitted:12' },
  })
})

it('shows nothing for a fresh worktree or a branch without one', () => {
  expect(workOf(12, branch, { unlanded: 0, uncommitted: 0 })).toBeUndefined()
  expect(workOf(12, branch, undefined)).toBeUndefined()
  expect(workOf(12, undefined, { unlanded: 2, uncommitted: 0 })).toBeUndefined()
})
