import { expect, it } from 'vitest'
import { advance, createState, overheadRows, rowsOf, usageTotal } from '../model/rows.ts'
import type { UsageLike } from '../model/rows.ts'
import { parts } from '../model/dimensions.ts'
import { assistant, entries, OWN, PRICE, toolResult } from './fixture.ts'

const close = (actual: number, expected: number, within = 1e-12) =>
  expect(Math.abs(actual - expected), `${actual} ≠ ${expected}`).toBeLessThan(within)
/** Tool shares are estimates, kept to a nano-dollar and a whole token. */
const estimate = (actual: number, expected: number) => close(actual, expected, 1e-9)
const rest = (row: ReturnType<typeof advance>[number]) =>
  row.cost.total - Object.values(row.tools ?? {}).reduce((sum, share) => sum + share.usd, 0)

it('allocator: own responses only, jumps split by characters, shares that sum to each response', () => {
  const state = createState(OWN)
  const rows = advance(state, entries)
  expect(rows.length, 'the inherited response of #5 is not a row').toBe(4)
  expect(rows.every((row) => row.conversation === OWN)).toBe(true)
  const [first, second, third, fourth] = rows as [
    (typeof rows)[0],
    (typeof rows)[0],
    (typeof rows)[0],
    (typeof rows)[0],
  ]

  // #12: the inherited bash result and the own input share the 890-token jump 1000 : 600.
  expect(first.tools!.bash.tokens).toBe(Math.round((890 * 1000) / 1600))
  expect([first.tools!.bash.carried, first.tools!.bash.added]).toStrictEqual([1, 1])
  const promptCost = (10 * PRICE.input + 1010 * PRICE.cacheRead + 980 * PRICE.cacheWrite) / 1e6
  const outputCost = (200 * PRICE.output) / 1e6
  // Output 500 chars: 100 text, 100 thinking, 100 bash arguments, 200 read arguments.
  estimate(first.tools!.bash.usd, (promptCost * 556.25) / 2000 + outputCost * 0.2)
  estimate(first.tools!.read.usd, outputCost * 0.4)
  expect(first.tools!.read.tokens).toBe(0)
  expect(first.gapMs).toBe(undefined)
  expect(first.rewrite).toBe(undefined)

  // #15: parallel results share the 800-token jump 500 : 1500; bash carries both its results.
  expect(second.tools!.bash.tokens).toBe(Math.round(556.25 + 200))
  expect(second.tools!.read.tokens).toBe(600)
  expect([second.tools!.bash.carried, second.tools!.bash.added]).toStrictEqual([2, 1])
  expect([second.tools!.read.carried, second.tools!.read.added]).toStrictEqual([1, 1])
  expect(second.gapMs).toBe(60_000)

  // #17: the compaction dropped what was carried; it only pays for its own call's arguments.
  expect(Object.keys(third.tools!)).toStrictEqual(['edit'])
  expect(third.tools!.edit.tokens).toBe(0)
  estimate(third.tools!.edit.usd, third.cost.output)
  expect(third.rewrite).toBe('idle')
  expect(third.gapMs).toBe(10 * 60_000)

  // #19: the edit result (text and an image) is the whole 160-token jump; a rewrite a minute later is not idle.
  expect(fourth.tools!.edit.tokens).toBe(1005 - 805 - 40)
  expect(fourth.rewrite).toBe('other')

  for (const row of rows) {
    expect(rest(row), 'tools never take more than the response cost').toBeGreaterThanOrEqual(-1e-15)
    close(
      Object.values(row.tools ?? {}).reduce((sum, share) => sum + share.usd, 0) + rest(row),
      row.cost.total,
    )
  }
})

it('allocator: advancing in batches gives the same rows as all at once, and skips what it has seen', () => {
  const whole = advance(createState(OWN), entries)
  const state = createState(OWN)
  const batched = [...advance(state, entries.slice(0, 6)), ...advance(state, entries.slice(4))]
  expect(batched).toStrictEqual(whole)
  expect(advance(state, entries)).toStrictEqual([])
})

it('allocator: a provider-reported total is split in the same proportions', () => {
  const state = createState(OWN)
  const [row] = advance(state, [
    assistant(1, OWN, { input: 100, output: 100, cacheRead: 0, cacheWrite: 0 }, 0, {
      text: 'x'.repeat(10),
      calls: [{ name: 'bash', arguments: { c: 'y'.repeat(2) } }],
      fromProvider: 0.001,
    }),
  ])
  expect(row.fromProvider).toBe(true)
  expect(row.cost.total).toBe(0.001)
  expect(row.tools!.bash.usd).toBeLessThanOrEqual(0.001)
  estimate(row.tools!.bash.usd, 0.001 * (2500 / 3000) * (10 / 20))
})

it('allocator: a tool named __proto__ is its own tool, not a write into Object.prototype', () => {
  const state = createState(OWN)
  const rows = advance(state, [
    toolResult(1, OWN, '__proto__', 500),
    assistant(2, OWN, { input: 500, output: 10, cacheRead: 0, cacheWrite: 0 }, 60_000, {
      text: 'ok',
    }),
  ])
  expect(({} as { tokens?: unknown }).tokens, 'Object.prototype stayed clean').toBe(undefined)
  expect(Object.getPrototypeOf(rows[0].tools), 'the row’s tools are a plain record').toBe(
    Object.prototype,
  )
  expect(Object.keys(rows[0].tools!), 'the tool is keyed by its own name').toStrictEqual([
    '__proto__',
  ])
  expect(rows[0].tools!['__proto__'].tokens).toBe(500 / 2.5)
  expect([rows[0].tools!['__proto__'].carried, rows[0].tools!['__proto__'].added]).toStrictEqual([
    1, 1,
  ])
  // And it is a tool of the surface's breakdown too, `(no tool)` holding the rest of the response.
  const conversation = {
    id: OWN,
    title: '#10',
    agent: 'agent',
    family: null,
    root: OWN,
    busy: false,
    concluded: false,
    usage: 0,
    live: true,
  }
  expect(parts(rows[0], conversation, 'tool').map((part) => part.key)).toStrictEqual([
    '__proto__',
    '(no tool)',
  ])
})

it('overhead: rows sum to the pi.usage total, summaries and direct tool spend included', () => {
  const state = createState(OWN)
  const rows = advance(state, entries)
  const sum = (key: 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'total') =>
    rows.reduce((total, row) => total + row.cost[key], 0)
  const usage: UsageLike = {
    models: {
      // The responses, plus a summary call on the same model.
      'anthropic/claude-opus-5-5': {
        input: 500,
        output: 500,
        cacheRead: 3200,
        cacheWrite: 4000,
        cost: {
          input: sum('input') + 0.001,
          output: sum('output') + 0.002,
          cacheRead: sum('cacheRead'),
          cacheWrite: sum('cacheWrite'),
          total: sum('total') + 0.003,
        },
      },
      // Titles and summaries on the router; and rounding below the threshold elsewhere.
      'proxy/shopify/explore': {
        input: 2000,
        output: 300,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { input: 0.004, output: 0.006, cacheRead: 0, cacheWrite: 0, total: 0.01 },
      },
    },
    tools: {
      web_search: {
        input: 100,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { input: 0.01, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.02 },
      },
    },
  }
  const overhead = overheadRows(state, usage)
  expect(overhead.length).toBe(3)
  expect(overhead.every((row) => row.overhead && row.at === rows.at(-1)!.at)).toBe(true)
  const router = overhead.find((row) => row.provider === 'proxy')!
  expect(router.model).toBe('shopify/explore')
  close(router.cost.total, 0.01)
  close(overhead.find((row) => row.model === 'claude-opus-5-5')!.cost.total, 0.003)
  expect(overhead.find((row) => row.direct)!.direct).toStrictEqual({ web_search: 0.02 })
  const all = rowsOf(state, usage)
  close(
    all.reduce((total, row) => total + row.cost.total, 0),
    usageTotal(usage),
  )
  expect(overheadRows(state, { models: {}, tools: {} })).toStrictEqual([])
})
