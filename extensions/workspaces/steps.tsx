import type { LanderStep } from './types.ts'

/** A running check's line gives way to its result, which follows it. */
export const superseded = (row: LanderStep, later: readonly LanderStep[]) =>
  row.runs !== undefined && later.some((next) => next.check?.command === row.runs)

/** A group's checks run together: a running check whose later rows all belong to its group still runs. */
const pending = (row: LanderStep, later: readonly LanderStep[]) =>
  row.runs !== undefined &&
  later.every((next) => next.check !== undefined || next.runs !== undefined)

/**
 * How long `row`, the step at `index` of the shown `rows`, took: until the next shown step starts; a check result's time is
 * its whole check, from its "checking" step in all of `steps`. Undefined while it is the last one.
 */
export const tookFor = (
  row: LanderStep,
  index: number,
  rows: readonly LanderStep[],
  steps: readonly LanderStep[],
) => {
  if (row.check) {
    const start = steps.findLast((other) => other.at <= row.at && other.runs === row.check!.command)
    return start ? row.at - start.at : undefined
  }
  const next = rows[index + 1]
  return next && (next.check ? undefined : next.at - row.at)
}

/** While its submission lands, a step is in progress when it is the last one or a group check still running; a check result never is. */
export const inProgress = (row: LanderStep, later: readonly LanderStep[]) =>
  !row.check && (!later.length || pending(row, later))
