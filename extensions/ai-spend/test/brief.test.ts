import { expect, it } from 'vitest'
import { brief } from '../model/brief.ts'
import { cacheBy } from '../model/cache.ts'
import { KINDS } from '../model/types.ts'
import type { Conversation, Row, SpendData } from '../model/types.ts'
import { OWN, PARENT, PRICE } from './fixture.ts'

const MIN = 60_000
const T = new Date(2026, 10, 16, 9).getTime()
const close = (actual: number, expected: number) =>
  expect(Math.abs(actual - expected), `${actual} ≠ ${expected}`).toBeLessThan(1e-12)
const write = (tokens: number) => (tokens * (PRICE.cacheWrite - PRICE.cacheRead)) / 1e6

const conversation = (id: number, agent: string): Conversation => ({
  id,
  title: `Conversation ${id}`,
  agent,
  family: 'lead',
  root: id,
  busy: false,
  concluded: false,
  usage: 0,
  live: true,
})
const rewrite = (
  id: number,
  at: number,
  cacheWrite: number,
  gapMs: number | undefined,
  model = 'claude-opus-5-5',
): Row => {
  const tokens = { input: 10, output: 100, cacheRead: 0, cacheWrite }
  const cost = Object.fromEntries(
    KINDS.map((kind) => [kind, (tokens[kind] * PRICE[kind]) / 1e6]),
  ) as Row['cost']
  cost.total = KINDS.reduce((sum, kind) => sum + cost[kind], 0)
  const idle = gapMs !== undefined && gapMs >= 5 * MIN
  return {
    conversation: id,
    at: T + at,
    provider: 'anthropic',
    model,
    tokens: { ...tokens, reasoning: 0 },
    cost,
    fromProvider: false,
    ...(gapMs === undefined ? {} : { gapMs }),
    rewrite: idle ? 'idle' : 'other',
  }
}

const data: SpendData = {
  epoch: 'a',
  version: 1,
  since: T,
  conversations: [conversation(OWN, 'coordinator'), conversation(PARENT, 'worker')],
  rows: [
    rewrite(OWN, 0, 60_000, undefined),
    rewrite(OWN, 20 * MIN, 120_000, 20 * MIN),
    rewrite(OWN, 110 * MIN, 250_000, 90 * MIN),
    rewrite(PARENT, 0, 10_000, undefined, 'claude-sonnet-5'),
    rewrite(PARENT, 10 * MIN, 40_000, 10 * MIN, 'claude-sonnet-5'),
  ],
  prices: { 'anthropic/claude-opus-5-5': PRICE, 'anthropic/claude-sonnet-5': PRICE },
}

it('cacheBy: leak per conversation and per model, the most first, with the share after pauses under an hour', () => {
  const [first, second, ...rest] = cacheBy(data, {}, 'conversation')
  expect(rest).toStrictEqual([])
  expect([first.key, first.responses, first.idle, first.model]).toStrictEqual([
    String(OWN),
    3,
    2,
    'anthropic/claude-opus-5-5',
  ])
  close(first.leakUsd, write(60_000) + write(120_000) + write(250_000))
  close(first.underHourUsd, write(120_000))
  expect([second.key, second.idle, second.model]).toStrictEqual([
    String(PARENT),
    1,
    'anthropic/claude-sonnet-5',
  ])
  close(second.underHourUsd, write(40_000))
  expect(cacheBy(data, {}, 'model', 1).map((line) => line.key)).toStrictEqual([
    'anthropic/claude-opus-5-5',
  ])
  expect(
    cacheBy(data, { agent: ['worker'] }, 'conversation').map((line) => line.key),
    'a filter narrows it like the rest of the page',
  ).toStrictEqual([String(PARENT)])
})

it('brief: the page numbers, the top leaks, what keep-warm really does, where settings live, and propose-only', () => {
  const text = brief({
    data,
    filter: { agent: ['coordinator'] },
    range: 'Nov 16',
    filters: [['agent', ['coordinator']]],
    total: 2,
  })
  const leaked = write(60_000) + write(120_000) + write(250_000)
  for (const part of [
    "## Spend's cache view: Nov 16, filters: agent = coordinator",
    `**Leaked:** $${leaked.toFixed(2)}, ${((leaked / 2) * 100).toFixed(1)}% of the $2.00 spent`,
    '**Ping while away** (estimate)',
    '**One-hour cache** (estimate)',
    '| idle rewrite: paused 5 min or more, the cache expired | 2 |',
    '| conversation | agent | model | idle rewrites | leaked | of it after pauses < 1 h |\n| --- | --- | --- | ---: | ---: | ---: |',
    '| · after 10–30 min | 1 |',
    '| · after 1–8 h | 1 |',
    `| #${OWN} | coordinator | anthropic/claude-opus-5-5 | 2 | $${leaked.toFixed(2)} | ${Math.round((write(120_000) / leaked) * 100)}% |`,
    '| anthropic/claude-opus-5-5 | 3 | 2 |',
    'keep-warm pings only @ultimate, 55 min after its last cache request',
    '`compaction.modelOverrides`',
    "`$PI_CODING_AGENT_DIR` when the server's environment sets it",
    '`PI_CACHE_RETENTION=long`',
    'Check project memory',
    'Change no file or setting until I say yes.',
  ])
    expect(text, `brief lacks: ${part}`).toContain(part)
  expect(text, 'the filtered-out worker is nowhere in it').not.toContain(`#${PARENT}`)
  expect(text).not.toContain('claude-sonnet-5')
  expect(text.endsWith('\n\n'), 'what is typed next starts a paragraph of its own').toBe(true)
})
