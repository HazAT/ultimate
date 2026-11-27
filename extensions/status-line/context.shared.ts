import type { UsageState } from '@earendil-works/pi-durable'

export function usageTotals(usage: Readonly<UsageState>) {
  return [...Object.values(usage.models), ...Object.values(usage.tools)].reduce(
    (sum, bucket) => ({
      input: sum.input + bucket.input,
      output: sum.output + bucket.output,
      cacheRead: sum.cacheRead + bucket.cacheRead,
      cacheWrite: sum.cacheWrite + bucket.cacheWrite,
      cost: sum.cost + bucket.cost.total,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
  )
}
