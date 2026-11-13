/** When a keep-warm ping is due. Browser-safe: the chip reads the hour too. */

/** Claude's long prompt cache lives an hour from the last request that read or wrote it. */
export const TTL = 60 * 60_000
/** Ping this long after the last request: late enough to be rare, early enough to land before the hour ends. */
export const LEAD = 55 * 60_000
/** No ping once the user has been away this long. */
export const IDLE_STOP = 8 * 60 * 60_000

export type Activity = {
  now: number
  /** The latest request on @ultimate's cache: its last answer or the last ping (ms). */
  lastRequest?: number
  /** The user's latest input (ms). */
  inputAt?: number
  /** A ping failed after this request: none again until a newer one. */
  failedAfter?: number
  /**
   * A hold with an end paused Ultimate at this time (ms): the user waits for it to play, so their absence counts only
   * up to it.
   */
  heldSince?: number
}

/** A ping failed at `failedAt` and no request renewed the cache since: a newer cached answer supersedes the failure. */
export const failing = (failedAt: number | undefined, lastRequest: number | undefined) =>
  failedAt !== undefined && (lastRequest === undefined || failedAt >= lastRequest)

/**
 * Whether to ping now: the cache is still warm but about to expire, the user wrote within `IDLE_STOP` (before a hold
 * with an end began, while one holds), and no ping failed since the last request. A cache already past its hour is
 * cold; a ping would only pay to rebuild it.
 */
export function due({ now, lastRequest, inputAt, failedAfter, heldSince }: Activity) {
  if (lastRequest === undefined || inputAt === undefined) return false
  if (failing(failedAfter, lastRequest)) return false
  const age = now - lastRequest
  return age >= LEAD && age < TTL && Math.min(now, heldSince ?? now) - inputAt < IDLE_STOP
}
