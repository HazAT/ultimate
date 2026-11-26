import type { Api, Model } from '@earendil-works/pi-ai'
import { expect, it } from 'vitest'
import {
  decide,
  keptBy,
  lateRefreshCutoff,
  resolvePolicy,
  streakAfterPing,
  timeline,
} from '../due.shared.ts'
import type { Policy, Situation } from '../due.shared.ts'
import { cacheTiming, oneTokenPayload, rewriteCost, warmCost } from '../server.ts'

const now = Date.parse('2026-11-16T12:00:00Z')
const minutes = (count: number) => count * 60_000
const policy: Policy = { warm: true, compact: true, warmMs: minutes(30), minCompactTokens: 150_000 }
const fiveMinutes = (change: Partial<Situation>): Situation => ({
  now,
  ttl: minutes(5),
  delayBeforeRefresh: minutes(4.5),
  realRequestAt: now - minutes(13.5),
  lastCacheRequestAt: now - minutes(4.5),
  from: 'request',
  windowStart: now - minutes(13.5),
  runActive: false,
  withinMaxWarm: true,
  tokens: 200_000,
  compactedSinceRequest: false,
  ...change,
})
const hour = (change: Partial<Situation>) =>
  fiveMinutes({
    ttl: minutes(60),
    delayBeforeRefresh: minutes(54),
    realRequestAt: now - minutes(54),
    lastCacheRequestAt: now - minutes(54),
    windowStart: now - minutes(54),
    ...change,
  })

it('pings a five-minute cache at 4.5 minutes for 30 minutes after the request, then compacts', () => {
  expect(decide(fiveMinutes({}), policy)).toBe('ping')
  expect(
    decide(
      fiveMinutes({ realRequestAt: now - minutes(31.5), windowStart: now - minutes(31.5) }),
      policy,
    ),
  ).toBe('compact')
  expect(
    decide(fiveMinutes({ realRequestAt: now - minutes(31.5), windowStart: now - minutes(31.5) }), {
      ...policy,
      compact: false,
    }),
  ).toEqual({
    stop: 'No request for 30 min',
  })
})

it('keeps a branch with a run warm for an hour after its request, and never compacts it', () => {
  expect(
    decide(
      fiveMinutes({
        runActive: true,
        realRequestAt: now - minutes(58.5),
        windowStart: now - minutes(58.5),
      }),
      policy,
    ),
  ).toBe('ping')
  expect(
    decide(
      fiveMinutes({
        runActive: true,
        realRequestAt: now - minutes(63),
        windowStart: now - minutes(63),
      }),
      policy,
    ),
  ).toEqual({
    stop: 'Run longer than 1 h',
  })
  expect(
    decide(
      fiveMinutes({
        runActive: true,
        realRequestAt: now - minutes(63),
        windowStart: now - minutes(63),
      }),
      {
        ...policy,
        warmMs: minutes(480),
      },
    ),
  ).toBe('ping')
})

it('skips a refresh that fires after half the margin before expiry', () => {
  const late = fiveMinutes({})
  expect(lateRefreshCutoff(late)).toBe(now + minutes(0.25))
  expect(decide({ ...late, now: now + minutes(0.25) }, policy)).toBe('ping')
  expect(decide({ ...late, now: now + minutes(0.25) + 1 }, policy)).toEqual({
    stop: 'Refresh came too late',
  })
})

it('does not compact a five-minute cache inside its window, nor warm it when off', () => {
  expect(decide(fiveMinutes({}), { ...policy, warm: false })).toEqual({
    stop: 'Off for this conversation',
  })
  expect(decide(fiveMinutes({ withinMaxWarm: false }), policy)).toEqual({
    stop: 'Over the limit of warm branches',
  })
})

it('compacts an hour-long cache at 54 minutes once its 30-minute idle window is over', () => {
  expect(decide(hour({}), policy)).toBe('compact')
  expect(decide(hour({}), { ...policy, warmMs: minutes(480) })).toBe('ping')
  expect(decide(hour({ tokens: 100_000 }), policy)).toEqual({
    stop: 'Too small to compact (under 150k)',
  })
  expect(decide(hour({ compactedSinceRequest: true }), policy)).toEqual({ stop: 'Compacted' })
})

it("takes the cache lifetime and refresh delay from the model's promptCache metadata", () => {
  const opus = {
    provider: 'anthropic',
    id: 'claude-opus-5-5',
    api: 'anthropic-messages',
    promptCache: { short: 300, long: 3600 },
  } as Model<Api>
  expect(cacheTiming(opus)).toEqual({ ttl: minutes(5), delayBeforeRefresh: minutes(4.5) })
  expect(cacheTiming({ ...opus, promptCache: undefined })).toBe(undefined)
  expect(
    cacheTiming({ ...opus, provider: 'github-copilot', promptCache: { short: 300, long: 3600 } }),
  ).toEqual({ ttl: minutes(5), delayBeforeRefresh: minutes(4.5) })
  expect(
    cacheTiming({ ...opus, provider: 'claude-code', api: 'claude-code', promptCache: undefined }),
  ).toEqual({ ttl: minutes(60), delayBeforeRefresh: minutes(54) })
  expect(cacheTiming({ ...opus, provider: 'claude-code', api: 'claude-code' })).toEqual({
    ttl: minutes(60),
    delayBeforeRefresh: minutes(54),
  })
})

it('caps a replayed Anthropic request at one output token, and refuses bodies it cannot cap', () => {
  const body = { model: 'x', max_tokens: 64_000, messages: [{ role: 'user', content: 'hi' }] }
  expect(oneTokenPayload('anthropic-messages', body)).toEqual({ ...body, max_tokens: 1 })
  expect(body.max_tokens).toBe(64_000)
  expect(oneTokenPayload('pi-messages', { options: { maxTokens: 8192 } })).toBe(undefined)
  expect(oneTokenPayload('anthropic-messages', { messages: [] })).toBe(undefined)
})

it("warms @ultimate for 8 h after the user's last input on an hour-long cache, 90 min on a five-minute one", () => {
  const ultimate = { warm: true, minutes: 480, shortMinutes: 90 }
  const long = resolvePolicy(ultimate, {}, minutes(60))
  expect(long.minutes).toEqual({ value: 480, source: 'agent' })
  const short = resolvePolicy(ultimate, {}, minutes(5))
  expect(short.minutes).toEqual({ value: 90, source: 'agent' })
  const fromInput = (inputAgo: number) =>
    hour({ from: 'input', windowStart: now - minutes(inputAgo), realRequestAt: now - minutes(54) })
  expect(decide(fromInput(470), { ...policy, warmMs: minutes(480) })).toBe('ping')
  expect(decide(fromInput(481), { ...policy, warmMs: minutes(480), compact: false })).toEqual({
    stop: 'No input from you for 8 h',
  })
  expect(
    decide(fiveMinutes({ from: 'input', windowStart: now - minutes(91) }), {
      ...policy,
      warmMs: minutes(90),
      compact: false,
    }),
  ).toEqual({ stop: 'No input from you for 90 min' })
  expect(
    decide(fiveMinutes({ from: 'input', windowStart: undefined }), { ...policy, compact: false }),
  ).toEqual({ stop: 'No input from you yet' })
})

it("takes a conversation's override over its agent definition, and the default without either", () => {
  expect(resolvePolicy(undefined, {}, minutes(5))).toEqual({
    warm: { value: false, source: 'default' },
    compact: { value: false, source: 'default' },
    minutes: { value: 30, source: 'default' },
    compactTokens: { value: 150_000, source: 'default' },
  })
  const coordinator = { warm: true, minutes: 30, compact: true, compactTokens: 100_000 }
  expect(resolvePolicy(coordinator, { warm: false, minutes: 120 }, minutes(5))).toEqual({
    warm: { value: false, source: 'override' },
    compact: { value: true, source: 'agent' },
    minutes: { value: 120, source: 'override' },
    compactTokens: { value: 100_000, source: 'agent' },
  })
})

it('plans from the newest of the real request and the ping after it, keeping them apart', () => {
  const model = { provider: 'claude-code', id: 'claude-opus-5-5' }
  const request = { at: now - minutes(59), provider: 'claude-code', model: 'claude-opus-5-5' }
  const ping = { ...request, at: now - minutes(5), read: 9, write: 0 }
  expect(timeline(request, ping, model)).toEqual({
    realRequestAt: now - minutes(59),
    lastCacheRequestAt: now - minutes(5),
  })
  expect(timeline(request, { ...ping, at: now - minutes(60) }, model)).toEqual({
    realRequestAt: now - minutes(59),
    lastCacheRequestAt: now - minutes(59),
  })
  expect(timeline(request, { ...ping, read: 0 }, model)).toEqual({ stop: 'Ping found no cache' })
  expect(timeline({ ...request, uncached: true }, undefined, model)).toEqual({
    stop: 'The last request used no cache',
  })
  expect(timeline(request, undefined, { ...model, id: 'claude-fable-5-1' })).toEqual({
    stop: 'Model changed',
  })
})

it('prices a rewrite and the warm window with the tier the context falls in', () => {
  const haiku = {
    provider: 'claude-code',
    id: 'claude-haiku-5-5',
    api: 'claude-code',
    cost: {
      input: 0.2,
      output: 1,
      cacheRead: 0.01,
      cacheWrite: 0.125,
      tiers: [
        { inputTokensAbove: 128_000, input: 1, output: 5, cacheRead: 0.05, cacheWrite: 0.625 },
      ],
    },
  } as unknown as Model<Api>
  expect(rewriteCost(haiku, minutes(60), 200_000)).toBeCloseTo(0.4)
  expect(rewriteCost(haiku, minutes(5), 200_000)).toBeCloseTo(0.125)
  expect(warmCost(haiku, minutes(4.5), 90, 200_000)).toEqual({
    pings: 20,
    cost: expect.closeTo(0.2),
  })
})

it("counts a recovered run's pings only toward that run, never toward an older answer's total", () => {
  const older = { since: now - minutes(120), cost: 0.3, pings: 2 }
  const recovered = now - minutes(30)
  expect(keptBy(older, recovered)).toBe(undefined)
  expect(keptBy({ since: recovered, cost: 0, pings: 0 }, recovered)).toBe(undefined)
  const first = streakAfterPing(older, recovered, 0.01)
  expect(first).toEqual({ since: recovered, cost: 0.01, pings: 1 })
  expect(keptBy(streakAfterPing(first, recovered, 0.01), recovered)).toEqual({
    cost: 0.02,
    pings: 2,
  })
})
