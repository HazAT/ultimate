const MINUTE_MS = 60_000
export const TTL = 60 * MINUTE_MS
export const LEAD = 55 * MINUTE_MS
export const IDLE_STOP = 8 * 60 * MINUTE_MS

export type Activity = {
  now: number
  lastRequest?: number
  inputAt?: number
  failedAfter?: number
}

export const failing = (failedAt: number | undefined, lastRequest: number | undefined) =>
  failedAt !== undefined && (lastRequest === undefined || failedAt >= lastRequest)

export function due({ now, lastRequest, inputAt, failedAfter }: Activity) {
  if (lastRequest === undefined || inputAt === undefined) return false
  if (failing(failedAfter, lastRequest)) return false
  const cacheAgeMs = now - lastRequest
  const cacheStillWarmAndNearExpiry = cacheAgeMs >= LEAD && cacheAgeMs < TTL
  return cacheStillWarmAndNearExpiry && now - inputAt < IDLE_STOP
}
