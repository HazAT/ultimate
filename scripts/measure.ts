export const median = (values: number[]) => {
  if (!values.length) throw new Error('No samples to take a median of')
  const sorted = values.toSorted((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

export function runsFlag(argv: string[]) {
  const index = argv.indexOf('--runs')
  const runs = index < 0 ? 3 : Number(argv[index + 1])
  if (!Number.isSafeInteger(runs) || runs < 1)
    throw new Error('--runs takes a whole number above 0')
  return runs
}
