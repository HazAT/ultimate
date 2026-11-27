import { expect, it } from 'vitest'
import { cache } from '../model/cache.ts'
import { csv } from '../model/csv.ts'
import { daily } from '../model/daily.ts'
import { merge } from '../model/data.ts'
import { cacheClass, parts, vendor } from '../model/dimensions.ts'
import { group } from '../model/groups.ts'
import { leak } from '../model/pricing.ts'
import { series } from '../model/series.ts'
import { summary } from '../model/summary.ts'
import { tools } from '../model/tools.ts'
import { turns } from '../model/turns.ts'
import { advance, createState, rowsOf } from '../model/rows.ts'
import { KINDS } from '../model/types.ts'
import type { Conversation, Row, Snapshot, SpendData } from '../model/types.ts'
import { assistant, entries, OWN, PRICE } from './fixture.ts'

const close = (actual: number, expected: number, message = '') =>
  expect(Math.abs(actual - expected), `${message} ${actual} ≠ ${expected}`).toBeLessThan(1e-12)
const conversation = (id: number, over: Partial<Conversation> = {}): Conversation => ({
  id,
  title: `Conversation ${id}`,
  agent: 'coordinator',
  family: 'lead',
  root: id,
  busy: false,
  concluded: false,
  usage: 0,
  live: true,
  ...over,
})
const DAY = 86_400_000
/** #10 (the fixture, 16 Nov) with a summary and direct tool spend; #20, a worker under it on the router, on 13 Nov. */
function snapshot(): SpendData {
  const own = createState(OWN)
  advance(own, entries)
  const rows: Row[] = rowsOf(own, {
    models: {
      'proxy/shopify/explore': {
        input: 1000,
        output: 100,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { input: 0.002, output: 0.003, cacheRead: 0, cacheWrite: 0, total: 0.005 },
      },
    },
    tools: {
      web_search: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.004 },
      },
    },
  })
  const worker = createState(20)
  const early = -3 * DAY
  advance(worker, [
    assistant(101, 20, { input: 100, output: 100, cacheRead: 0, cacheWrite: 2000 }, early, {
      calls: [{ name: 'read', arguments: { path: 'x' } }],
    }),
  ])
  for (const row of worker.rows) Object.assign(row, { provider: 'proxy', model: 'shopify/explore' })
  rows.push(...worker.rows)
  return {
    epoch: 'instance-a',
    version: 1,
    since: Math.min(...rows.map((row) => row.at)),
    conversations: [
      conversation(OWN),
      conversation(20, { agent: 'worker', owner: OWN, root: OWN, family: 'default' }),
    ],
    rows,
    prices: { 'anthropic/claude-opus-5-5': PRICE },
  }
}

it('parts: by kind and by tool they sum to each row’s total, overhead rows included', () => {
  const data = snapshot()
  for (const row of data.rows) {
    const owner = data.conversations.find((item) => item.id === row.conversation)!
    for (const dimension of ['kind', 'tool', 'model'] as const)
      close(
        parts(row, owner, dimension).reduce((sum, part) => sum + part.usd, 0),
        row.cost.total,
        dimension,
      )
  }
  const direct = data.rows.find((row) => row.direct)!
  expect(parts(direct, data.conversations[0], 'tool').map((part) => part.key)).toStrictEqual([
    'web_search',
    '(overhead)',
  ])
  expect(vendor('proxy', 'shopify/explore')).toBe('Shopify proxy')
  expect(vendor('anthropic', 'claude-opus-5-5')).toBe('anthropic')
})

it('group: by agent then model, largest first, children summing to their group, daily across the range', () => {
  const data = snapshot()
  const from = new Date(2026, 10, 13).getTime()
  const to = new Date(2026, 10, 17).getTime()
  const groups = group(data, { from, to }, 'agent', 'model')
  expect(groups.map((item) => item.key)).toStrictEqual(['coordinator', 'worker'])
  const total = data.rows.reduce((sum, row) => sum + row.cost.total, 0)
  close(
    groups.reduce((sum, item) => sum + item.usd, 0),
    total,
  )
  for (const item of groups) {
    close(
      item.children!.reduce((sum, child) => sum + child.usd, 0),
      item.usd,
    )
    expect(item.daily.length).toBe(4)
    close(
      item.daily.reduce((sum, usd) => sum + usd, 0),
      item.usd,
    )
  }
  expect(groups[0].responses, 'overhead rows are not responses').toBe(4)
  expect(groups[1].daily.map((usd) => usd > 0)).toStrictEqual([true, false, false, false])
  const trees = group(data, {}, 'tree')
  expect(trees.length).toBe(1)
  expect(trees[0].label).toBe('Conversation 10')
  // Filtering by a tool keeps only its share; grouping by tool under it shows only that tool.
  const read = group(data, { tool: ['read'] }, 'model', 'tool')
  const readUsd = tools(data, {}).find((tool) => tool.tool === 'read')!.usd
  close(
    read.reduce((sum, item) => sum + item.usd, 0),
    readUsd,
  )
  expect(read.every((item) => item.children!.every((child) => child.key === 'read'))).toBe(true)
  expect(csv(groups)).toMatch(/^group,subgroup,usd,tokens,responses\ncoordinator,,/)
})

it('tools: the share of input is a ratio of tokens, so it never passes the whole of the prompts', () => {
  const data = snapshot()
  // Filtering by a tool keeps the responses that carry one of its results: its own tokens over theirs. The dollars the
  // filter selects used to be the denominator, and bash's results are a small part of them but a large part of the
  // tokens (116% before).
  const bash = tools(data, { tool: ['bash'] }).find((tool) => tool.tool === 'bash')!
  const carrying = data.rows.filter((row) => !row.overhead && row.tools?.['bash'])
  const promptOf = (row: Row) => row.tokens.input + row.tokens.cacheRead + row.tokens.cacheWrite
  const prompts = carrying.reduce((sum, row) => sum + promptOf(row), 0)
  const tokens = carrying.reduce((sum, row) => sum + row.tools!['bash'].tokens, 0)
  close(bash.inputShare, tokens / prompts)
  expect(bash.inputShare > 0 && bash.inputShare <= 1, `${bash.inputShare}`).toBe(true)
  // A tool and a token kind at once scale both sides by the kind's share of the dollars, and stay a ratio of tokens.
  const shareOfInput = (row: Row) => row.cost.input / row.cost.total
  const both = tools(data, { tool: ['bash'], kind: ['input'] }).find(
    (tool) => tool.tool === 'bash',
  )!
  close(
    both.inputShare,
    carrying.reduce((sum, row) => sum + row.tools!['bash'].tokens * shareOfInput(row), 0) /
      carrying.reduce((sum, row) => sum + promptOf(row) * shareOfInput(row), 0),
  )
  expect(both.inputShare <= 1, `${both.inputShare}`).toBe(true)
})

it('summary: cache figures, overhead and estimates', () => {
  const data = snapshot()
  const day16 = new Date(2026, 10, 16).getTime()
  const result = summary(data, { from: day16 })
  const worker = data.rows.find((row) => row.conversation === 20)!
  close(
    result.usd + worker.cost.total,
    data.rows.reduce((sum, row) => sum + row.cost.total, 0),
  )
  close(result.overheadUsd, 0.009)
  expect(result.responses).toBe(4)
  expect(result.estimatedShare).toBe(1)
  expect(result.cacheHitRate > 0 && result.cacheHitRate < 1).toBe(true)
  expect(result.cacheSavingsUsd > 0).toBe(true)
})

it('tools, daily and series', () => {
  const data = snapshot()
  const byTool = tools(data, {})
  const web = byTool.find((tool) => tool.tool === 'web_search')!
  close(web.directUsd, 0.004)
  const bash = byTool.find((tool) => tool.tool === 'bash')!
  // bash results: one added in #12, one in #15; carried in 1 + 2 prompts.
  close(bash.avgRereads, 3 / 2)
  expect(bash.inputShare > 0 && bash.inputShare < 1).toBe(true)
  const now = new Date(2026, 10, 17, 8).getTime()
  const days = daily(data, {}, now)
  expect(days.map((day) => day.day)).toStrictEqual([
    '2026-11-13',
    '2026-11-14',
    '2026-11-15',
    '2026-11-16',
    '2026-11-17',
  ])
  close(
    days.reduce((sum, day) => sum + day.usd, 0),
    data.rows.reduce((sum, row) => sum + row.cost.total, 0),
  )
  const weeks = series(data, {}, 'week', 'model', 1, now)
  expect(weeks.buckets.map((at) => new Date(at).getDate())).toStrictEqual([9, 16])
  expect(weeks.stacks.map((stack) => stack.key)).toStrictEqual([
    'anthropic/claude-opus-5-5',
    'other',
  ])
  // From the worker's response (13 Nov 09:00) to now (17 Nov 08:00).
  expect(series(data, {}, 'hour', 'agent', 6, now).buckets.length).toBe(4 * 24 - 1)
})

it('series by hour across the DST fall-back ends and keeps the repeated hour apart', () => {
  const zone = process.env.TZ
  process.env.TZ = 'America/New_York'
  try {
    const data = snapshot()
    // 01:30 EDT and 01:30 EST on 1 Nov 2026.
    const [first, second] = [Date.UTC(2026, 10, 1, 5, 30), Date.UTC(2026, 10, 1, 6, 30)]
    data.rows.forEach((row, i) => (row.at = i % 2 ? second : first))
    const from = Date.UTC(2026, 10, 1, 4)
    const hours = series(
      data,
      { from, to: from + 4 * 3_600_000 },
      'hour',
      'agent',
      6,
      from + 4 * 3_600_000,
    )
    expect(hours.buckets.length).toBe(4)
    const totals = hours.buckets.map((_, i) =>
      hours.stacks.reduce((sum, stack) => sum + stack.values[i], 0),
    )
    expect(totals[1] > 0 && totals[2] > 0, `hourly totals ${totals.join(',')}`).toBe(true)
  } finally {
    if (zone === undefined) delete process.env.TZ
    else process.env.TZ = zone
  }
})

/** What the server answers with no version: every conversation, its rows by id. */
const full = (data: SpendData, version: number): Snapshot => ({
  epoch: data.epoch,
  version,
  since: data.since,
  conversations: data.conversations,
  rows: Object.fromEntries(
    data.conversations.map((item) => [
      item.id,
      { from: 0, rows: data.rows.filter((row) => row.conversation === item.id) },
    ]),
  ),
  prices: data.prices,
})

it('merge: a version from another server instance brings all of the data, replacing what was held', () => {
  const before = snapshot()
  const held = merge(null, full(before, 7))
  // A reloaded server: another epoch, and its store no longer holds #20 (it was the earlier chapter's).
  const after: SpendData = { ...before, epoch: 'another-instance' }
  const replaced = merge(
    held,
    full(
      {
        ...after,
        rows: after.rows.filter((row) => row.conversation !== 20),
        conversations: after.conversations.filter((item) => item.id !== 20),
      },
      3,
    ),
  )
  expect(replaced.epoch).toBe('another-instance')
  expect(replaced.version).toBe(3)
  expect(
    replaced.conversations.map((item) => item.id),
    'a conversation the full snapshot does not name is gone, not kept from the other instance',
  ).toStrictEqual([OWN])
  expect(replaced.rows.every((row) => row.conversation === OWN)).toBe(true)
  // The same answer within one instance still merges: only the rows a delta brings are replaced.
  const kept = merge(held, { ...full(before, 8), rows: {} })
  expect(kept.rows.length).toBe(held.rows.length)
})

it('merge: a full snapshot, then an append delta of one conversation, equals a fresh full snapshot', () => {
  const before = snapshot()
  // #10 gains a response and is now busy; its overhead rows are recomputed after it. #20 is unchanged.
  const own = before.rows.filter((row) => row.conversation === OWN)
  const responses = own.filter((row) => !row.overhead)
  expect(responses.length === 4 && own.length > responses.length).toBe(true)
  const response = { ...responses.at(-1)!, at: responses.at(-1)!.at + 60_000 }
  const overhead = own
    .filter((row) => row.overhead)
    .map((row) => ({
      ...row,
      at: response.at,
      cost: { ...row.cost, total: row.cost.total + 0.001 },
    }))
  const after: SpendData = {
    ...before,
    conversations: before.conversations.map((item) =>
      item.id === OWN ? { ...item, busy: true } : item,
    ),
    rows: [
      ...responses,
      response,
      ...overhead,
      ...before.rows.filter((row) => row.conversation !== OWN),
    ],
  }
  const delta: Snapshot = {
    epoch: after.epoch,
    version: 2,
    since: after.since,
    conversations: [after.conversations.find((item) => item.id === OWN)!],
    rows: { [OWN]: { from: responses.length, rows: [response, ...overhead] } },
    prices: after.prices,
  }
  const held = merge(null, full(before, 1))
  expect(held).toStrictEqual({ ...before, version: 1 })
  expect(merge(held, delta)).toStrictEqual(merge(null, full(after, 2)))
  // Through JSON, as the action delivers it: ids arrive as string keys.
  expect(merge(held, JSON.parse(JSON.stringify(delta)) as Snapshot)).toStrictEqual(
    merge(null, full(after, 2)),
  )
})

it('cache: classes, leaks, idle gaps, the two what-ifs, prompt bands, priciest turns and the served model', () => {
  const MIN = 60_000
  const T = new Date(2026, 10, 16, 9).getTime()
  /** A response priced like the fixture, at `T + at`. */
  const response = (
    at: number,
    tokens: Omit<Row['tokens'], 'reasoning'>,
    extra: Partial<Row> = {},
  ): Row => {
    const cost = Object.fromEntries(
      KINDS.map((kind) => [kind, (tokens[kind] * PRICE[kind]) / 1e6]),
    ) as Row['cost']
    cost.total = KINDS.reduce((sum, kind) => sum + cost[kind], 0)
    return {
      conversation: OWN,
      at: T + at,
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      tokens: { ...tokens, reasoning: 0 },
      cost,
      fromProvider: false,
      ...extra,
    }
  }
  const rows: Row[] = [
    response(0, { input: 10, output: 100, cacheRead: 0, cacheWrite: 60_000 }, { rewrite: 'other' }),
    response(MIN, { input: 10, output: 100, cacheRead: 60_000, cacheWrite: 1000 }, { gapMs: MIN }),
    response(
      21 * MIN,
      { input: 10, output: 100, cacheRead: 1000, cacheWrite: 120_000 },
      { gapMs: 20 * MIN, rewrite: 'idle' },
    ),
    response(
      21 * MIN + 1,
      { input: 10, output: 100, cacheRead: 0, cacheWrite: 250_000 },
      { gapMs: 90 * MIN, rewrite: 'idle' },
    ),
    // A router's response that missed an implicit cache, and a small prompt that no provider caches.
    response(
      30 * MIN,
      { input: 40_000, output: 100, cacheRead: 0, cacheWrite: 0 },
      { gapMs: MIN, provider: 'proxy', model: 'shopify/dev', served: 'claude-opus-5-5' },
    ),
    response(31 * MIN, { input: 2000, output: 100, cacheRead: 0, cacheWrite: 0 }, { gapMs: MIN }),
    {
      ...response(32 * MIN, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
      overhead: true,
    },
  ]
  // The router's own model has no price table: its cache-read rate is the one of the model that answered.
  const data: SpendData = {
    epoch: 'a',
    version: 1,
    since: T,
    conversations: [conversation(OWN)],
    rows,
    prices: { 'anthropic/claude-opus-5-5': PRICE },
  }
  const write = (tokens: number) => (tokens * (PRICE.cacheWrite - PRICE.cacheRead)) / 1e6
  const report = cache(data, {})
  const byKey = Object.fromEntries(report.classes.map((entry) => [entry.key, entry]))
  expect(
    Object.fromEntries(report.classes.map((entry) => [entry.key, entry.responses])),
  ).toStrictEqual({
    'idle rewrite': 2,
    miss: 1,
    'first/changed': 1,
    hit: 1,
    uncached: 1,
    '(overhead)': 0,
  })
  close(byKey['idle rewrite'].leakUsd, write(120_000) + write(250_000))
  close(byKey['first/changed'].leakUsd, write(60_000))
  close(byKey.miss.leakUsd, (40_000 * (PRICE.input - PRICE.cacheRead)) / 1e6)
  close(byKey.hit.leakUsd + byKey.uncached.leakUsd, 0)
  // Mostly input with a cache write of its own is no implicit miss: it leaks nothing.
  const mixed = response(0, { input: 12_000, output: 100, cacheRead: 0, cacheWrite: 1000 })
  expect(cacheClass(mixed)).toBe('partial')
  expect(leak(mixed, data.prices)).toBe(0)
  close(
    report.leakUsd,
    report.classes.reduce((sum, entry) => sum + entry.leakUsd, 0),
  )
  close(
    report.classes.reduce((sum, entry) => sum + entry.usd, 0),
    rows.reduce((sum, row) => sum + row.cost.total, 0),
  )
  expect(report.gaps.map((gap) => gap.responses)).toStrictEqual([0, 1, 0, 1, 0])
  // Pings: 20 min holds 4, 90 min holds 20, each reading that response's prompt from the cache.
  expect([report.pinging.rewrites, report.pinging.pings]).toStrictEqual([2, 24])
  close(report.pinging.costUsd, ((4 * 121_010 + 20 * 250_010) * PRICE.cacheRead) / 1e6)
  close(report.pinging.savedUsd, byKey['idle rewrite'].leakUsd)
  // A one-hour cache: every write at twice the input rate, but the 20-minute rewrite would have been a hit, not a write.
  expect(report.hourCache.rewrites).toBe(1)
  close(
    report.hourCache.extraUsd,
    ((60_000 + 1000 + 250_000) * (2 * PRICE.input - PRICE.cacheWrite)) / 1e6,
  )
  close(report.hourCache.savedUsd, write(120_000))
  // Two 100k writes 20 minutes apart: $1.25 as paid, $1.00 + $0.05 with a one-hour cache, so it saves $0.20.
  const pair: SpendData = {
    ...data,
    rows: [
      response(0, { input: 0, output: 0, cacheRead: 0, cacheWrite: 100_000 }),
      response(
        20 * MIN,
        { input: 0, output: 0, cacheRead: 0, cacheWrite: 100_000 },
        { gapMs: 20 * MIN, rewrite: 'idle' },
      ),
    ],
  }
  const hour = cache(pair, {}).hourCache
  close(hour.savedUsd - hour.extraUsd, 0.2)

  const bands = group(data, {}, 'prompt')
  expect(bands.map((band) => band.key)).toStrictEqual([
    '<50k',
    '50–100k',
    '100–200k',
    '200k+',
    '(overhead)',
  ])
  close(
    bands.reduce((sum, band) => sum + band.usd, 0),
    rows.reduce((sum, row) => sum + row.cost.total, 0),
  )
  expect(
    group(data, {}, 'model').some((model) => model.label === 'proxy/shopify/dev → claude-opus-5-5'),
  ).toBe(true)

  const top = turns(data, {}, 3)
  expect(top.map((turn) => turn.row.at)).toStrictEqual([T + 21 * MIN + 1, T + 21 * MIN, T])
  expect(top[0].cache).toBe('idle rewrite')
  close(top[0].leakUsd, write(250_000))
})
