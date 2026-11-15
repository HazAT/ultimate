export type Rates = { input: number; output: number; cacheRead: number; cacheWrite: number }
export type RateSample = { rates: Rates; elapsed: number }
export const keys = ['input', 'output', 'cacheRead', 'cacheWrite'] as const
export const zero = (): Rates => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
const maxSamplingGapMs = 5000
const windowMs = 30000

export function createRateSampler() {
  let points: { at: number; total: Rates }[] = []
  return (at: number, total: Rates): RateSample | null => {
    const previous = points.at(-1)
    if (!previous || at < previous.at || at - previous.at > maxSamplingGapMs) {
      points = [{ at, total: { ...total } }]
      return null
    }
    if (at === previous.at) return null
    points.push({ at, total: { ...total } })
    const cutoff = at - windowMs
    while (points.length > 2 && points[1].at <= cutoff) points.shift()
    const first = points[0]
    const next = points[1]
    const start = Math.max(first.at, cutoff)
    const fraction = (start - first.at) / (next.at - first.at)
    const elapsed = (at - start) / 1000
    const rates = zero()
    for (const key of keys) {
      const baseline = first.total[key] + (next.total[key] - first.total[key]) * fraction
      const signedCorrectionPerSecond = (total[key] - baseline) / elapsed
      rates[key] = Math.max(0, signedCorrectionPerSecond)
    }
    return { rates, elapsed }
  }
}
