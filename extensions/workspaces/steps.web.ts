import type { LanderStep } from './types.ts'

export const superseded = (row: LanderStep, later: readonly LanderStep[]) =>
  row.runs !== undefined && later.some((next) => next.check?.command === row.runs)

export const visibleSteps = (steps: readonly LanderStep[]) =>
  steps.filter((row, index) => !superseded(row, steps.slice(index + 1)))

const checkGroupStillRunning = (row: LanderStep, later: readonly LanderStep[]) =>
  row.runs !== undefined &&
  later.every((next) => next.check !== undefined || next.runs !== undefined)

export const tookFor = (
  row: LanderStep,
  index: number,
  shownRows: readonly LanderStep[],
  allLoggedSteps: readonly LanderStep[],
) => {
  if (row.check) {
    const checkingStepBeforeResult = allLoggedSteps.findLast(
      (other) => other.at <= row.at && other.runs === row.check!.command,
    )
    return checkingStepBeforeResult ? row.at - checkingStepBeforeResult.at : undefined
  }
  const nextShownStep = shownRows[index + 1]
  return nextShownStep && (nextShownStep.check ? undefined : nextShownStep.at - row.at)
}

export const inProgress = (row: LanderStep, later: readonly LanderStep[]) =>
  !row.check && (!later.length || checkGroupStillRunning(row, later))
