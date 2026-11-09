import { expect, it } from 'vitest'
import { inProgress, superseded, tookFor } from '../../steps.tsx'
import type { LanderStep } from '../../types.ts'

/** The rows a landing submission's card shows, which of them spin and what they took, as `Steps` in log.tsx decides. */
function card(steps: LanderStep[]) {
  const rows = steps.filter((row, index) => !superseded(row, steps.slice(index + 1)))
  return rows.map((row, index) => ({
    row: row.step,
    spinning: inProgress(row, rows.slice(index + 1)),
    took: tookFor(row, index, rows, steps),
  }))
}

it('shows a finished group check with its result while its sibling still spins', () => {
  const steps: LanderStep[] = [
    { step: 'setting up', at: 1 },
    { step: 'checking: a', at: 2, runs: 'a' },
    { step: 'checking: b', at: 3, runs: 'b' },
    { step: 'checked: a', at: 4, check: { command: 'a', result: 'passed', summary: 'a ok' } },
  ]
  expect(card(steps)).toEqual([
    { row: 'setting up', spinning: false, took: 2 },
    { row: 'checking: b', spinning: true, took: undefined },
    { row: 'checked: a', spinning: false, took: 2 },
  ])
  // B's result replaces its running row; then nothing in the group spins.
  steps.push({ step: 'checked: b', at: 7, check: { command: 'b', result: 'failed' } })
  expect(card(steps)).toEqual([
    { row: 'setting up', spinning: false, took: undefined },
    { row: 'checked: a', spinning: false, took: 2 },
    { row: 'checked: b', spinning: false, took: 4 },
  ])
  // The next ordinary step is the one in progress.
  steps.push({ step: 'fast-forwarding', at: 8 })
  expect(card(steps).at(-1)).toEqual({ row: 'fast-forwarding', spinning: true, took: undefined })
})
