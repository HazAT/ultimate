import { expect, it, vi } from 'vitest'
import { due, failing, IDLE_STOP, LEAD, TTL } from '../due.ts'
import * as keepWarm from '../server.ts'

const now = Date.parse('2026-10-24T12:00:00Z')
const minutes = (count: number) => count * 60_000

it('pings in the last minutes of the cache hour while the user was here recently', () => {
  expect(due({ now, lastRequest: now - LEAD, inputAt: now - minutes(70) })).toBe(true)
  expect(due({ now, lastRequest: now - minutes(59), inputAt: now - minutes(59) })).toBe(true)
})

it('waits while the cache is fresh and never pings a cold one', () => {
  expect(due({ now, lastRequest: now - minutes(30), inputAt: now - minutes(30) })).toBe(false)
  expect(due({ now, lastRequest: now - TTL, inputAt: now - minutes(61) })).toBe(false)
})

it('stops once the user has been away 8 hours, and without any input', () => {
  expect(due({ now, lastRequest: now - LEAD, inputAt: now - IDLE_STOP })).toBe(false)
  expect(due({ now, lastRequest: now - LEAD })).toBe(false)
  expect(due({ now, inputAt: now })).toBe(false)
})

it('does not retry after a failed ping until a newer request', () => {
  const lastRequest = now - LEAD
  const inputAt = now - minutes(70)
  expect(due({ now, lastRequest, inputAt, failedAfter: lastRequest + 1 })).toBe(false)
  expect(due({ now, lastRequest, inputAt, failedAfter: lastRequest - 1 })).toBe(true)
})

it('clears a failed ping once a cached @ultimate answer follows it', () => {
  const failedAt = now - minutes(300)
  expect(failing(failedAt, now - minutes(355))).toBe(true)
  expect(failing(failedAt, undefined)).toBe(true)
  expect(failing(failedAt, now - minutes(10))).toBe(false)
  expect(failing(undefined, now)).toBe(false)
})

it('warms Claude Code, and the Anthropic API only under long cache retention', () => {
  vi.stubEnv('PI_CACHE_RETENTION', undefined)
  expect(keepWarm.hourLong('claude-code')).toBe(true)
  expect(keepWarm.hourLong('anthropic')).toBe(false)
  vi.stubEnv('PI_CACHE_RETENTION', 'long')
  expect(keepWarm.hourLong('anthropic')).toBe(true)
  expect(keepWarm.hourLong('openai')).toBe(false)
  vi.unstubAllEnvs()
})

it('counts only answers that read or wrote the current model’s cache', () => {
  const answer = (change: Record<string, unknown>) =>
    ({
      role: 'assistant',
      provider: 'claude-code',
      model: 'claude-opus-5-5',
      stopReason: 'stop',
      usage: { cacheRead: 500_000, cacheWrite: 2_000 },
      ...change,
    }) as unknown as Parameters<typeof keepWarm.cached>[0]
  const opus = { provider: 'claude-code', modelId: 'claude-opus-5-5' }
  expect(keepWarm.cached(answer({}), opus)).toBe(true)
  expect(keepWarm.cached(answer({ stopReason: 'error' }), opus)).toBe(false)
  expect(keepWarm.cached(answer({ model: 'claude-fable-5-1' }), opus)).toBe(false)
  expect(keepWarm.cached(answer({ provider: 'openai-codex' }), opus)).toBe(false)
  expect(keepWarm.cached(answer({}), { ...opus, provider: 'anthropic' })).toBe(false)
  expect(keepWarm.cached(answer({ usage: { cacheRead: 0, cacheWrite: 0 } }), opus)).toBe(false)
})

it('counts a ping only on the provider and model it warmed', () => {
  const ping = { at: now, provider: 'claude-code', model: 'claude-opus-5-5' }
  expect(keepWarm.lastOn(ping, { provider: 'claude-code', modelId: 'claude-opus-5-5' })).toBe(ping)
  expect(keepWarm.lastOn(ping, { provider: 'anthropic', modelId: 'claude-opus-5-5' })).toBe(
    undefined,
  )
  expect(keepWarm.lastOn(ping, { provider: 'claude-code', modelId: 'claude-fable-5-1' })).toBe(
    undefined,
  )
})

it('sends only while not paused and within the hour, checked right before the request', () => {
  expect(keepWarm.open(false, now - LEAD, now)).toBe(true)
  expect(keepWarm.open(true, now - LEAD, now)).toBe(false)
  expect(keepWarm.open(undefined, now - LEAD, now)).toBe(true)
  expect(keepWarm.open(false, now - TTL, now)).toBe(false)
})
