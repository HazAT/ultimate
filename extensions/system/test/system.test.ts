import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import type { JsonValue } from '@earendil-works/chord'
import { actions, lanes } from '../server.ts'
import type { SystemRow } from '../refs.ts'
import type { ActionContext } from '../../../server/actions.ts'
import type { ExtensionHost } from '../../../server/extensions.ts'
import { callTrace } from '../../../server/trace.ts'
import type { EventRecord } from '../../../shared/events.ts'
import type { ConversationSummary } from '../../../shared/protocol.ts'
import { fauxServer, linkDependencies, temp } from '../../../test/helpers.ts'

const servers: Awaited<ReturnType<typeof fauxServer>>[] = []
afterAll(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})
afterEach(() => {
  vi.restoreAllMocks()
})

const T0 = Date.parse('2026-10-19T12:00:00Z')
/** An in-memory event log with the semantics of `host.eventLog.recent`. */
function eventLog(events: EventRecord[]) {
  return {
    async recent(options: {
      events?: readonly { kind: string }[]
      since?: number
      before?: number
      order?: 'ascending' | 'descending'
      limit?: number
    }) {
      const kinds = options.events && new Set(options.events.map((event) => event.kind))
      const matching = events.filter(
        (event) =>
          (!kinds || kinds.has(event.kind)) &&
          (options.since === undefined || event.id > options.since) &&
          (options.before === undefined || event.id < options.before),
      )
      const ordered = options.order === 'ascending' ? matching : matching.toReversed()
      return structuredClone(ordered.slice(0, options.limit ?? 20))
    },
  }
}
const event = (
  id: number,
  name: string,
  seconds: number,
  data: JsonValue,
  context?: EventRecord['context'],
): EventRecord => ({
  id,
  name,
  kind: `event.${name}`,
  v: 1,
  at: new Date(T0 + seconds * 1000).toISOString(),
  data,
  ...(context ? { context } : {}),
})

/**
 * A trace with calls at chosen seconds after T0, an event log, conversation summaries, and the stream action over
 * them.
 */
async function fixture(events: EventRecord[] = [], summaries: ConversationSummary[] = []) {
  const trace = callTrace(join(await temp(), 'trace.sqlite'))
  trace.open()
  const clock = vi.spyOn(performance, 'now')
  /** Record a call that starts at `seconds` and takes `ms`. */
  const call = (
    name: string,
    seconds: number,
    options: {
      kind?: string
      ms?: number
      fail?: string
      conversation?: number
      args?: unknown
    } = {},
  ) => {
    const start = T0 + seconds * 1000 - performance.timeOrigin
    clock.mockReturnValueOnce(start).mockReturnValueOnce(start + (options.ms ?? 0))
    const work = () => {
      if (options.fail) throw new Error(options.fail)
      return 'ok'
    }
    try {
      trace.run(
        {
          kind: (options.kind ?? 'service') as 'service',
          caller: 'a',
          callee: 'b',
          name,
          args: options.args,
          conversationId: options.conversation,
        },
        work,
        null,
      )
    } catch {
      // The failing call is the point; its row is what the test reads.
    }
  }
  const log = eventLog(events)
  /** Conversations with a live foreground task. */
  const running = new Set<number>()
  const harness = {
    watchTaskGraph: async () => ({
      value: {
        tasks: Object.fromEntries(
          [...running].map((id) => [id, { conversationId: id, background: false }]),
        ),
      },
      stop: async () => {},
    }),
  }
  const host = {
    trace: trace.reader,
    eventLog: log,
    harness: () => harness,
    conversations: () => summaries,
  } as unknown as ExtensionHost
  const ctx = { host } as ActionContext
  const stream = (args: Record<string, unknown> = {}) =>
    actions.stream(args as JsonValue, ctx) as Promise<{
      rows: SystemRow[]
      next?: string
      head: string
    }>
  const tree = (traceId: string) => actions.tree({ trace: traceId }, ctx)
  /** Lanes as of `seconds` after T0. */
  const lanesAt = (seconds: number, args: Record<string, unknown> = {}) =>
    lanes(host, args, T0 + seconds * 1000)
  /** The id of the call named `name` (the first, or the `nth`). */
  const idOf = (name: string, nth = 0) =>
    trace.reader.query({ limit: 1000 }).filter((row) => row.name === name)[nth].id
  return { trace, call, events, stream, tree, running, lanesAt, idOf, ctx }
}
const names = (rows: SystemRow[]) => rows.map((row) => row.name)

it('merges events and calls newest first, calls by when they finished', async () => {
  const f = await fixture([event(1, 'x.one', 1, { n: 1 }), event(5, 'x.two', 4, { n: 2 })])
  f.call('c.at2', 2)
  f.call('c.at3', 3)
  f.call('c.long', 0, { ms: 5000 }) // started first, finished (and so was written) last
  const { rows, next, head } = await f.stream()
  expect(names(rows)).toEqual(['c.long', 'x.two', 'c.at3', 'c.at2', 'x.one'])
  expect(next).toBeUndefined()
  expect(rows[1]).toMatchObject({
    id: 'e5',
    source: 'event',
    kind: 'event',
    ok: true,
    summary: '{"n":2}',
  })
  expect(rows[0]).toMatchObject({ source: 'call', kind: 'service', ok: true, ms: 5000 })
  expect(rows[0].summary).toBe('a → b')
  expect(head).toBe('5.3')
})

it('leaves a call without arguments at caller and callee, not a literal null', async () => {
  const f = await fixture()
  f.call('c.none', 1, { args: null })
  f.call('c.some', 2, { args: { n: 1 } })
  const { rows } = await f.stream()
  expect(rows.map((row) => row.summary)).toEqual(['a → b  {"n":1}', 'a → b'])
})

it('pages back with before without gaps or repeats, across both sources', async () => {
  const events = Array.from({ length: 23 }, (_, index) =>
    event(index * 2 + 1, 'x.tick', index * 3 + 1, { index }),
  )
  const f = await fixture(events)
  for (let index = 0; index < 37; index++) f.call(`c${index}`, index * 2)
  const everything = (await f.stream({ limit: 500 })).rows
  expect(everything).toHaveLength(60)
  const seen: SystemRow[] = []
  let before: string | undefined
  let pages = 0
  do {
    const page = await f.stream({ limit: 7, ...(before ? { before } : {}) })
    expect(page.rows.length).toBeLessThanOrEqual(7)
    seen.push(...page.rows)
    before = page.next
    pages++
  } while (before)
  expect(pages).toBe(9)
  expect(seen.map((row) => row.id)).toEqual(everything.map((row) => row.id))
  const times = seen.map((row) => Date.parse(row.at) + (row.ms ?? 0))
  expect(times).toEqual(times.toSorted((a, b) => b - a))
})

it('follows live with after: only what came since, oldest pages first when behind', async () => {
  const events = [event(1, 'x.one', 1, null)]
  const f = await fixture(events)
  f.call('c.old', 0)
  const { head } = await f.stream({ limit: 5 })
  expect((await f.stream({ after: head })).rows).toEqual([])
  events.push(event(2, 'x.two', 10, null))
  f.call('c.new', 11)
  const live = await f.stream({ after: head })
  expect(names(live.rows)).toEqual(['c.new', 'x.two'])
  expect((await f.stream({ after: live.head })).rows).toEqual([])
  // Seven new rows, read three at a time from the oldest: all arrive once.
  for (let index = 0; index < 4; index++) f.call(`c.burst${index}`, 20 + index * 2)
  for (let index = 0; index < 3; index++)
    events.push(event(3 + index, `x.burst${index}`, 21 + index * 2, null))
  const followed: string[] = []
  let cursor = live.head
  for (let round = 0; round < 3; round++) {
    const page = await f.stream({ after: cursor, limit: 3 })
    followed.unshift(...names(page.rows))
    cursor = page.head
  }
  expect(followed).toEqual([
    'c.burst3',
    'x.burst2',
    'c.burst2',
    'x.burst1',
    'c.burst1',
    'x.burst0',
    'c.burst0',
  ])
  expect((await f.stream({ after: cursor })).rows).toEqual([])
})

it('filters by source, kind, conversation, text and errors', async () => {
  const f = await fixture([
    event(1, 'x.landed', 1, { sha: 'abc' }, { conversationId: 7, traceId: 't' }),
    event(2, 'x.branched', 2, { id: 3 }),
  ])
  f.call('alpha/go', 3, { kind: 'action', conversation: 7, args: { q: 'needle' } })
  f.call('bash', 4, { kind: 'tool', conversation: 8 })
  f.call('beta.work', 5, { fail: 'exploded', conversation: 7 })
  expect(names((await f.stream({ sources: ['event'] })).rows)).toEqual(['x.branched', 'x.landed'])
  expect(names((await f.stream({ sources: ['call'] })).rows)).toEqual([
    'beta.work',
    'bash',
    'alpha/go',
  ])
  expect(names((await f.stream({ kinds: ['tool', 'x.landed'] })).rows)).toEqual([
    'bash',
    'x.landed',
  ])
  expect(names((await f.stream({ conversation: 7 })).rows)).toEqual([
    'beta.work',
    'alpha/go',
    'x.landed',
  ])
  expect(names((await f.stream({ text: 'NEEDLE' })).rows)).toEqual(['alpha/go'])
  expect(names((await f.stream({ text: 'abc' })).rows)).toEqual(['x.landed'])
  expect(names((await f.stream({ text: '%' })).rows)).toEqual([])
  const errors = (await f.stream({ errors: true })).rows
  expect(errors).toEqual([
    expect.objectContaining({ name: 'beta.work', ok: false, error: 'exploded' }),
  ])
  // Filters page too: one row a page, three pages.
  const first = await f.stream({ conversation: 7, limit: 1 })
  const second = await f.stream({ conversation: 7, limit: 1, before: first.next })
  const third = await f.stream({ conversation: 7, limit: 1, before: second.next })
  expect([first, second, third].map((page) => names(page.rows)[0])).toEqual([
    'beta.work',
    'alpha/go',
    'x.landed',
  ])
  expect(third.next).toBeUndefined()
})

it("groups each conversation's tool and model calls into runs split by quiet, open while recent or busy", async () => {
  const f = await fixture([
    event(1, 'subagents.started', 0, {
      id: 9,
      agent: 'worker',
      model: 'anthropic/opus',
      kind: 'child',
      parent: 7,
    }),
  ])
  // Conversation 7: a run at 100–112 s, 30 s of quiet, then a run from 142 s that is still going at 150 s.
  f.call('read', 100, { kind: 'tool', conversation: 7, ms: 2000 })
  f.call('anthropic/opus', 105, { kind: 'model', conversation: 7, ms: 7000 })
  f.call('bash', 142, { kind: 'tool', conversation: 7, fail: 'exit 1', ms: 1000 })
  // Conversation 9 ended at 61 s; services and calls outside the window are not lanes.
  f.call('edit', 60, { kind: 'tool', conversation: 9, ms: 1000 })
  f.call('alpha/go', 140, { kind: 'action', conversation: 8 })
  f.call('old', -2000, { kind: 'tool', conversation: 10 })
  const result = await f.lanesAt(150)
  expect(result.now).toBe(new Date(T0 + 150_000).toISOString())
  // 9 is 7's child (its event says so), listed after it as the window's lanes are; no spawn call to point at.
  expect(result.lanes.map((lane) => lane.conversation)).toEqual([7, 9])
  expect(result.links).toEqual([])
  const [seven, nine] = result.lanes
  expect(seven.runs).toEqual([
    {
      start: new Date(T0 + 100_000).toISOString(),
      end: new Date(T0 + 112_000).toISOString(),
      ok: true,
      calls: [
        expect.objectContaining({
          kind: 'tool',
          name: 'read',
          ms: 2000,
          ok: true,
          trace: expect.any(String),
        }),
        expect.objectContaining({ kind: 'model', name: 'anthropic/opus', ms: 7000 }),
      ],
    },
    {
      start: new Date(T0 + 142_000).toISOString(),
      ok: false,
      calls: [expect.objectContaining({ name: 'bash', ok: false })],
    },
  ])
  expect(nine).toMatchObject({
    conversation: 9,
    agent: 'worker',
    model: 'anthropic/opus',
    kind: 'child',
    parent: 7,
    runs: [{ end: new Date(T0 + 61_000).toISOString() }],
  })
  // Later, 7's last run has ended, unless the conversation still has a live task.
  expect((await f.lanesAt(400)).lanes[0].runs[1].end).toBe(new Date(T0 + 143_000).toISOString())
  f.running.add(7)
  expect((await f.lanesAt(400)).lanes[0].runs[1].end).toBeUndefined()
  // A window in the past is never open, and takes only its calls.
  const past = await f.lanesAt(400, {
    since: new Date(T0 + 50_000).toISOString(),
    until: new Date(T0 + 104_000).toISOString(),
  })
  expect(past.lanes.map((lane) => [lane.conversation, lane.runs.map((run) => run.end)])).toEqual([
    [7, [new Date(T0 + 102_000).toISOString()]],
    [9, [new Date(T0 + 61_000).toISOString()]],
  ])
  await expect(f.lanesAt(0, { since: 'soon' })).rejects.toThrow('since')
})

it('links each lane to its parent and the call that spawned it, exact or inferred', async () => {
  const iso = (seconds: number) => new Date(T0 + seconds * 1000).toISOString()
  const events: EventRecord[] = []
  const f = await fixture(events, [
    // 30 has no event: its owner, 3, is its parent, though 3 did nothing in the window.
    { id: 30, parentConversationId: 3, busy: false },
    // 40 branched from 99, which never worked either.
    { id: 40, branchOf: { conversationId: 99, at: 1 }, busy: false },
    // 99 has a parent too, but only one hop above a working lane is listed.
    { id: 99, parentConversationId: 98, busy: false },
  ])
  // 7 spawns 8 by `subagent` at 100 s, then 9 at 120 s; a message call at 130 s.
  f.call('subagent', 100, { kind: 'tool', conversation: 7, ms: 1000 })
  f.call('subagent', 120, { kind: 'tool', conversation: 7, ms: 1000 })
  f.call('message', 130, { kind: 'tool', conversation: 7, ms: 500 })
  f.call('read', 103, { kind: 'tool', conversation: 8 })
  f.call('read', 125, { kind: 'tool', conversation: 9 })
  f.call('message', 140, { kind: 'tool', conversation: 9 })
  f.call('read', 110, { kind: 'tool', conversation: 30 })
  f.call('read', 115, { kind: 'tool', conversation: 40 })
  // A message sent by an action the tool call ran: its context names the action, the link names the tool call.
  const start = T0 + 150_000 - performance.timeOrigin
  vi.spyOn(performance, 'now')
    .mockReturnValueOnce(start)
    .mockReturnValueOnce(start + 1)
    .mockReturnValueOnce(start + 2)
    .mockReturnValueOnce(start + 3)
  f.trace.run(
    { kind: 'tool', caller: 'agent', callee: 'codemode', name: 'codemode', conversationId: 8 },
    () =>
      f.trace.run(
        { kind: 'action', caller: 'codemode', callee: 'messages', name: 'messages/send' },
        () => 1,
      ),
    null,
  )
  const action = f.trace.reader.query({ limit: 1000 }).find((row) => row.name === 'messages/send')!
  events.push(
    // From before the window (ids follow time): no link.
    event(0, 'board.sent', -5000, { message: 5, from: 7, to: 8, reply: false, steer: false }),
    // 8's event names the call that started it.
    event(
      1,
      'subagents.started',
      100.5,
      { id: 8, agent: 'worker', kind: 'child', parent: 7 },
      {
        conversationId: 7,
        traceId: f.idOf('subagent'),
        parentCall: f.idOf('subagent'),
      },
    ),
    // 9's names none: the last spawning call before the event, 7's second `subagent`, stands for it.
    event(2, 'subagents.started', 121, { id: 9, agent: 'reviewer', kind: 'child', parent: 7 }),
    event(
      3,
      'board.sent',
      130.2,
      { message: 1, from: 7, to: 9, reply: true, steer: false },
      {
        conversationId: 7,
        traceId: f.idOf('message'),
        parentCall: f.idOf('message'),
      },
    ),
    event(4, 'board.sent', 140.1, { message: 2, from: 9, to: 7, reply: false, steer: false }),
    event(
      5,
      'board.sent',
      150,
      { message: 3, from: 8, to: 7, reply: false, steer: false },
      {
        conversationId: 8,
        traceId: action.trace,
        parentCall: action.id,
      },
    ),
    // To the user: no link.
    event(6, 'board.sent', 141, { message: 4, from: 9, to: 'user', reply: true, steer: false }),
  )
  const result = await f.lanesAt(200)
  const byId = new Map(result.lanes.map((lane) => [lane.conversation, lane]))
  expect([...byId.keys()].toSorted((a, b) => a - b)).toEqual([3, 7, 8, 9, 30, 40, 99])
  expect(byId.get(3)).toEqual({ conversation: 3, runs: [] })
  expect(byId.get(99)).toEqual({ conversation: 99, runs: [] })
  expect(byId.get(8)).toMatchObject({
    parent: 7,
    spawn: { call: f.idOf('subagent'), at: iso(100) },
  })
  expect(byId.get(8)!.spawn!.inferred).toBeUndefined()
  expect(byId.get(9)).toMatchObject({
    parent: 7,
    agent: 'reviewer',
    spawn: { call: f.idOf('subagent', 1), at: iso(120), inferred: true },
  })
  // 3 and 99 have no calls, so nothing to infer 30's or 40's spawn from.
  expect(byId.get(30)).toMatchObject({ parent: 3 })
  expect(byId.get(30)!.spawn).toBeUndefined()
  expect(byId.get(40)).toMatchObject({ parent: 99 })
  expect(byId.get(40)!.spawn).toBeUndefined()
  expect(result.links).toEqual([
    { from: 7, to: 9, call: f.idOf('message'), at: iso(130), kind: 'message' },
    { from: 9, to: 7, at: iso(140.1), kind: 'message' },
    {
      from: 8,
      to: 7,
      call: f.idOf('codemode'),
      at: f.trace.reader.query({ limit: 1000 }).find((row) => row.name === 'codemode')!.at,
      kind: 'message',
    },
  ])
})

it('keeps a parent with its child under the cap', async () => {
  const f = await fixture([], [{ id: 500, parentConversationId: 600, busy: false }])
  for (let conversation = 1; conversation <= 39; conversation++)
    f.call('read', 100 + conversation, { kind: 'tool', conversation })
  // 500 is the least recently active; its parent would make 41, so both stay out.
  f.call('read', 50, { kind: 'tool', conversation: 500 })
  const result = await f.lanesAt(200)
  expect(result.lanes).toHaveLength(39)
  expect(result.more).toBe(1)
  f.call('read', 51, { kind: 'tool', conversation: 501 })
  const capped = await f.lanesAt(200)
  // 501 needs no parent and fits; 500 still does not.
  expect(capped.lanes.map((lane) => lane.conversation)).toContain(501)
  expect(capped.more).toBe(1)
})

it('brings the parent of an active lane that another active lane already listed', async () => {
  // C (802) under B (801) under idle A (800): C, the most recent, lists B as its parent first; B still brings A.
  const f = await fixture(
    [],
    [
      { id: 802, parentConversationId: 801, busy: false },
      { id: 801, parentConversationId: 800, busy: false },
    ],
  )
  f.call('read', 60, { kind: 'tool', conversation: 801 })
  f.call('read', 90, { kind: 'tool', conversation: 802 })
  const result = await f.lanesAt(200)
  const byId = new Map(result.lanes.map((lane) => [lane.conversation, lane]))
  expect([...byId.keys()].toSorted((a, b) => a - b)).toEqual([800, 801, 802])
  expect(byId.get(802)?.parent).toBe(801)
  expect(byId.get(801)?.parent).toBe(800)
  expect(byId.get(800)?.runs).toEqual([])
})

it('caps lanes at 40 and calls at 200 per run, counting the rest', async () => {
  const f = await fixture()
  for (let conversation = 1; conversation <= 43; conversation++)
    f.call('read', conversation, { kind: 'tool', conversation })
  for (let index = 0; index < 205; index++)
    f.call(`t${index}`, 100 + index / 10, { kind: 'tool', conversation: 99 })
  const result = await f.lanesAt(200)
  expect(result.lanes).toHaveLength(40)
  expect(result.more).toBe(4)
  // Most recently active first.
  expect(result.lanes.slice(0, 3).map((lane) => lane.conversation)).toEqual([99, 43, 42])
  const [run] = result.lanes[0].runs
  expect(run.calls).toHaveLength(200)
  expect(run.more).toBe(5)
  expect(run.calls[0].name).toBe('t0')
})

it('counts repeated polls instead of streaming them, and lists the counts', async () => {
  const f = await fixture()
  const poll = () =>
    f.trace.run({ kind: 'action', caller: 'ui', callee: 'x', name: 'x/state' }, () => 1, null)
  for (let i = 0; i < 4; i++) poll()
  expect(names((await f.stream()).rows)).toEqual(['x/state'])
  const { polls } = actions.polls(null, f.ctx)
  expect(polls).toEqual([{ name: 'x/state', count: 3, since: expect.any(String) }])
})

it('rejects malformed arguments', async () => {
  const f = await fixture()
  await expect(f.stream({ limit: 501 })).rejects.toThrow('limit')
  await expect(f.stream({ before: 'yesterday' })).rejects.toThrow('Invalid before cursor')
  await expect(f.stream({ before: '1.1', after: '1.1' })).rejects.toThrow('not both')
  await expect(f.stream({ sources: ['task'] })).rejects.toThrow('sources')
  await expect(f.tree('')).rejects.toThrow('Expected { trace }')
})

// The real event log and action plumbing: `recent({ before, order })`, and a tree with the events emitted in it.
it('returns a trace tree with its events on a running server', async () => {
  const root = await temp('ultimate-system-')
  await linkDependencies(root)
  await mkdir(join(root, 'web'))
  await writeFile(
    join(root, 'vite.config.ts'),
    "export default { root: 'web', optimizeDeps: { noDiscovery: true } }",
  )
  await mkdir(join(root, 'extensions/alpha'), { recursive: true })
  await symlink(resolve('extensions/system'), join(root, 'extensions/system'))
  await writeFile(
    join(root, 'extensions/alpha/server.ts'),
    `import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { defineEvent } from '${resolve('shared/events.ts')}'
const Pinged = defineEvent('alpha.pinged')
export default { name: 'alpha' }
export const actions = {
  ping: async (args, { host }) => host.harness().commit((tx) => host.emit(tx, Pinged, args), BACKGROUND_CONTEXT),
}`,
  )
  const home = await temp()
  const server = await fauxServer({ ultimateRoot: root, home, userHome: home })
  servers.push(server)
  const signal = new AbortController().signal
  const invoke = (extension: string, action: string, args: JsonValue) =>
    server.extensions.invoke(extension, action, args, signal, 1)
  for (const n of [1, 2, 3]) await invoke('alpha', 'ping', { n })
  const stream = (await invoke('system', 'stream', { kinds: ['alpha.pinged', 'action'] })) as {
    rows: SystemRow[]
  }
  // Both sources newest first, merged by time (events carry millisecond times, so ties within one may interleave).
  const of = (source: string) =>
    stream.rows.filter((row) => row.source === source).map((row) => row.summary)
  expect(of('event')).toEqual(['{"n":3}', '{"n":2}', '{"n":1}'])
  expect(of('call')).toEqual(['ui → alpha  {"n":3}', 'ui → alpha  {"n":2}', 'ui → alpha  {"n":1}'])
  // Newest first by finish time. `at` carries whole milliseconds, so a call's finish read back from it can be up to
  // 1 ms early: calls finishing within the same millisecond may appear swapped by less than that.
  const times = stream.rows.map((row) => Date.parse(row.at) + (row.ms ?? 0))
  for (const [index, time] of times.slice(1).entries())
    expect(time).toBeLessThanOrEqual(times[index] + 1)
  // Older than the newest event, calls used up: the middle event, then the first.
  const newest = stream.rows.find((row) => row.source === 'event')!.id.slice(1)
  // Only the pings: opening storage recorded `ultimate.started` before them.
  const paged = (await invoke('system', 'stream', {
    kinds: ['alpha.pinged'],
    limit: 1,
    before: `${newest}.0`,
  })) as { rows: SystemRow[]; next?: string }
  expect(paged.rows.map((row) => row.summary)).toEqual(['{"n":2}'])
  const last = (await invoke('system', 'stream', {
    kinds: ['alpha.pinged'],
    limit: 1,
    before: paged.next!,
  })) as { rows: SystemRow[]; next?: string }
  expect(last.rows.map((row) => row.summary)).toEqual(['{"n":1}'])
  expect(last.next).toBeUndefined()
  // Following from the stream's head (ascending event reads): only the next ping.
  const head = ((await invoke('system', 'stream', { sources: ['event'] })) as { head: string }).head
  await invoke('alpha', 'ping', { n: 4 })
  const live = (await invoke('system', 'stream', { sources: ['event'], after: head })) as {
    rows: SystemRow[]
  }
  expect(live.rows.map((row) => row.summary)).toEqual(['{"n":4}'])
  // Lanes read the real task graph; actions are not tool or model calls, so no lanes.
  expect(await invoke('system', 'lanes', {})).toEqual({
    now: expect.any(String),
    lanes: [],
    links: [],
  })
  const second = stream.rows.find((row) => row.source === 'event' && row.summary === '{"n":2}')!
  const tree = (await invoke('system', 'tree', { trace: second.trace! })) as {
    calls: { name: string; children: unknown[] }[]
    events: SystemRow[]
  }
  expect(tree.calls.map((call) => call.name)).toEqual(['alpha/ping'])
  expect(tree.events).toEqual([
    expect.objectContaining({ name: 'alpha.pinged', summary: '{"n":2}', conversation: 1 }),
  ])

  // The surface's polls carry moving cursors, so they never repeat: successful ones are counted, not written.
  const systemRows = () =>
    server.extensions.trace.query({ limit: 1000 }).filter((row) => row.callee === 'system')
  expect(systemRows()).toEqual([])
  const first = (await invoke('system', 'stream', {})) as { head: string }
  await invoke('alpha', 'ping', { n: 5 })
  await invoke('system', 'stream', { after: first.head })
  expect(systemRows()).toEqual([])
  const { polls } = (await invoke('system', 'polls', null)) as {
    polls: { name: string; count: number }[]
  }
  expect(polls).toEqual(
    expect.arrayContaining([expect.objectContaining({ name: 'system/stream' })]),
  )
  // A failing one is written.
  await expect(invoke('system', 'stream', { before: 'yesterday' })).rejects.toThrow(
    'Invalid before cursor',
  )
  expect(systemRows()).toMatchObject([{ name: 'system/stream', ok: false }])

  // Navigation: a change of surface or conversation is one event with the browser's device; a repeat is none.
  const device = { device: 'desktop firefox', login: 'me@example.com' }
  const navigate = (args: JsonValue) =>
    server.extensions.invoke('system', 'navigated', args, signal, 1, 'ui', device)
  expect(await navigate({ surface: 'agent', conversation: 7 })).toEqual({ recorded: true })
  expect(await navigate({ surface: 'agent', conversation: 7 })).toEqual({ recorded: false })
  expect(await navigate({ surface: 'system' })).toEqual({ recorded: true })
  expect(await navigate({ surface: 'system' })).toEqual({ recorded: false })
  // Two tabs reporting the same new view at once record it once.
  const racing = await Promise.all([
    navigate({ surface: 'review' }),
    navigate({ surface: 'review' }),
  ])
  expect(racing.filter((result) => (result as { recorded: boolean }).recorded)).toHaveLength(1)
  const navigated = (await invoke('system', 'stream', { kinds: ['ui.navigated'] })) as {
    rows: SystemRow[]
  }
  expect(navigated.rows.map((row) => JSON.parse(row.summary))).toEqual([
    { surface: 'review', ...device },
    { surface: 'system', ...device },
    { surface: 'agent', conversation: 7, ...device },
  ])
})
