import type { WireSummary } from './refs.ts'

const MAX_RESPONSE_START_DISTANCE_MS = 60_000

export function callFor(
  calls: readonly WireSummary[],
  responseId: string | undefined,
  at: number,
): WireSummary | undefined {
  if (responseId) return calls.find((call) => call.responseId === responseId)
  let best: WireSummary | undefined
  for (const call of calls)
    if (!best || Math.abs(call.startedAt - at) < Math.abs(best.startedAt - at)) best = call
  return best && Math.abs(best.startedAt - at) <= MAX_RESPONSE_START_DISTANCE_MS ? best : undefined
}
