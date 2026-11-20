import { CACHE_WARMING_MAX_AGE_MS } from '@earendil-works/pi-ai'
import type { CachePolicy } from '../subagents/refs.ts'
import { duration } from './duration.ts'
import type { WarmDocState, Setting } from './refs.ts'

export type Step = 'ping' | 'compact'

export type Policy = {
  warm: boolean
  compact: boolean
  warmMs: number
  minCompactTokens: number
}

export type Situation = {
  now: number
  ttl: number
  delayBeforeRefresh: number
  realRequestAt: number
  lastCacheRequestAt: number
  from: 'input' | 'request'
  windowStart: number | undefined
  runActive: boolean
  withinMaxWarm: boolean
  tokens: number
  compactedSinceRequest: boolean
}

export type Decision = Step | { stop: string }

export const DEFAULTS = { warm: false, compact: false, minutes: 30, compactTokens: 150_000 }
const HOUR_MS = 3_600_000

export function resolvePolicy(
  cache: CachePolicy | undefined,
  overrides: Pick<WarmDocState, 'warm' | 'compact' | 'minutes'>,
  ttl: number | undefined,
) {
  const agentMinutes =
    ttl !== undefined && ttl < HOUR_MS ? (cache?.shortMinutes ?? cache?.minutes) : cache?.minutes
  function pick<T>(override: T | undefined, agent: T | undefined, fallback: T): Setting<T> {
    if (override !== undefined) return { value: override, source: 'override' }
    if (agent !== undefined) return { value: agent, source: 'agent' }
    return { value: fallback, source: 'default' }
  }
  return {
    warm: pick(overrides.warm, cache?.warm, DEFAULTS.warm),
    compact: pick(overrides.compact, cache?.compact, DEFAULTS.compact),
    minutes: pick(overrides.minutes, agentMinutes, DEFAULTS.minutes),
    compactTokens: pick(undefined, cache?.compactTokens, DEFAULTS.compactTokens),
  }
}

export const policyOf = (resolved: ReturnType<typeof resolvePolicy>): Policy => ({
  warm: resolved.warm.value,
  compact: resolved.compact.value,
  warmMs: resolved.minutes.value * 60_000,
  minCompactTokens: resolved.compactTokens.value,
})

export const lateRefreshCutoff = (
  situation: Pick<Situation, 'ttl' | 'delayBeforeRefresh' | 'lastCacheRequestAt'>,
) => {
  const dueAt = situation.lastCacheRequestAt + situation.delayBeforeRefresh
  const halfTheMarginBeforeExpiry = Math.floor((situation.ttl - situation.delayBeforeRefresh) / 2)
  return dueAt + halfTheMarginBeforeExpiry
}

export const warmWindowEnd = (
  situation: Pick<Situation, 'realRequestAt' | 'runActive' | 'windowStart'>,
  policy: Policy,
) => {
  const idle = (situation.windowStart ?? -Infinity) + policy.warmMs
  return situation.runActive
    ? Math.max(idle, situation.realRequestAt + CACHE_WARMING_MAX_AGE_MS)
    : idle
}

export function decide(situation: Situation, policy: Policy): Decision {
  if (situation.now > lateRefreshCutoff(situation)) return { stop: 'Refresh came too late' }
  const end = warmWindowEnd(situation, policy)
  const windowOpen = situation.now <= end
  if (policy.warm && windowOpen)
    return situation.withinMaxWarm ? 'ping' : { stop: 'Over the limit of warm branches' }
  if (situation.runActive)
    return {
      stop: policy.warm
        ? `Run longer than ${duration(end - situation.realRequestAt)}`
        : 'Off for this conversation',
    }
  if (windowOpen) return { stop: 'Off for this conversation' }
  if (!policy.compact && policy.warm && policy.warmMs <= situation.ttl)
    return { stop: 'No ping needed' }
  if (situation.windowStart === undefined) return { stop: 'Keeps warm after next message' }
  if (!policy.compact)
    return {
      stop:
        situation.from === 'input'
          ? `No input from you for ${duration(policy.warmMs)}`
          : `No request for ${duration(policy.warmMs)}`,
    }
  if (situation.tokens < policy.minCompactTokens)
    return { stop: `Too small to compact (under ${Math.round(policy.minCompactTokens / 1000)}k)` }
  if (situation.compactedSinceRequest) return { stop: 'Compacted' }
  return 'compact'
}

type Streak = NonNullable<WarmDocState['streak']>

export const streakAfterPing = (
  streak: Streak | undefined,
  realRequestAt: number,
  cost: number,
): Streak => {
  const own = streak?.since === realRequestAt ? streak : { since: realRequestAt, cost: 0, pings: 0 }
  return { ...own, cost: own.cost + cost, pings: own.pings + 1 }
}

export const keptBy = (streak: Streak | undefined, realRequestAt: number) =>
  streak?.since === realRequestAt && streak.pings > 0
    ? { cost: streak.cost, pings: streak.pings }
    : undefined
