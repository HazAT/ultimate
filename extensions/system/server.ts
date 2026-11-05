import type { JsonValue } from '@earendil-works/chord'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { defineDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { implementAction } from '../../lib/actions.ts'
import { defineEvent, NavigatedEvent } from '../../shared/events.ts'
import type { EventRecord } from '../../shared/events.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import type { CallRow, CallTree } from '../../server/trace.ts'
import { LanesAction, NavigatedAction, PollsAction, StreamAction, TreeAction } from './refs.ts'
import type { Lane, LaneLink, LaneSpawn, SystemCall, SystemFilter, SystemRow } from './refs.ts'

const SUMMARY = 200
const cut = (text: string) => (text.length > SUMMARY ? `${text.slice(0, SUMMARY - 1)}…` : text)

function eventRow(event: EventRecord): SystemRow {
  return {
    id: `e${event.id}`,
    source: 'event',
    at: event.at,
    kind: 'event',
    name: event.name,
    ...(event.context?.conversationId === undefined
      ? {}
      : { conversation: event.context.conversationId }),
    ...(event.context?.traceId === undefined ? {} : { trace: event.context.traceId }),
    ok: true,
    summary: cut(JSON.stringify(event.data) ?? ''),
  }
}
function callRow(call: CallRow): SystemRow {
  return {
    id: call.id,
    source: 'call',
    at: call.at,
    kind: call.kind,
    name: call.name,
    ...(call.conversation === undefined ? {} : { conversation: call.conversation }),
    trace: call.trace,
    ok: call.ok,
    ms: call.ms,
    ...(call.error === undefined ? {} : { error: call.error }),
    // An action called without arguments stores `null`, which says nothing.
    summary: cut(
      [`${call.caller} → ${call.callee}`, call.args === 'null' ? undefined : call.args]
        .filter(Boolean)
        .join('  '),
    ),
  }
}

/** Where a page stopped in each source: an event id and a trace position, exclusive; 0 when nothing is left. */
type Cursor = { e: number; c: number }
const encode = (cursor: Cursor) => `${cursor.e}.${cursor.c}`
function decode(text: unknown, name: string): Cursor | undefined {
  if (text === undefined) return undefined
  const match = typeof text === 'string' ? /^(\d+)\.(\d+)$/.exec(text) : null
  if (!match) throw new Error(`Invalid ${name} cursor: ${JSON.stringify(text)}`)
  return { e: Number(match[1]), c: Number(match[2]) }
}

/** A row ready to merge: its source position and the time it sorts by (a call's by when it finished). */
type Item = { row: SystemRow; position: number; time: number }

function strings(value: unknown, name: string) {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string'))
    throw new Error(`Expected ${name} to be a list of strings`)
  return value
}

function filterOf(args: Record<string, unknown>): SystemFilter {
  const sources = strings(args.sources, 'sources') as SystemFilter['sources']
  if (sources?.some((source) => source !== 'event' && source !== 'call'))
    throw new Error('Expected sources to name "event" or "call"')
  const kinds = strings(args.kinds, 'kinds')
  const { conversation, errors, text } = args
  if (conversation !== undefined && !Number.isInteger(conversation))
    throw new Error('Expected conversation to be an integer')
  if (errors !== undefined && typeof errors !== 'boolean')
    throw new Error('Expected errors to be a boolean')
  if (text !== undefined && typeof text !== 'string')
    throw new Error('Expected text to be a string')
  return {
    ...(sources ? { sources } : {}),
    ...(kinds ? { kinds } : {}),
    ...(conversation === undefined ? {} : { conversation: conversation as number }),
    ...(errors ? { errors } : {}),
    ...(text ? { text } : {}),
  }
}

/** At most `limit` matching events after (ascending) or before (descending) event id `from`. */
async function events(
  host: ExtensionHost,
  filter: SystemFilter,
  from: number,
  ascending: boolean,
  limit: number,
): Promise<Item[]> {
  const tokens = filter.kinds?.map((name) => defineEvent(name))
  const text = filter.text?.toLowerCase()
  const found: Item[] = []
  let position = from
  for (;;) {
    const page = await host.eventLog.recent({
      ...(tokens ? { events: tokens } : {}),
      ...(ascending ? { since: position, order: 'ascending' } : { before: position }),
      limit,
    })
    for (const event of page) {
      position = event.id
      if (
        filter.conversation !== undefined &&
        event.context?.conversationId !== filter.conversation
      )
        continue
      if (text && !`${event.name} ${JSON.stringify(event.data)}`.toLowerCase().includes(text))
        continue
      found.push({ row: eventRow(event), position: event.id, time: Date.parse(event.at) })
      if (found.length === limit) return found
    }
    if (page.length < limit) return found
  }
}

/** At most `limit` matching calls after (ascending) or before (descending) trace position `from`. */
function calls(
  host: ExtensionHost,
  filter: SystemFilter,
  from: number,
  ascending: boolean,
  limit: number,
) {
  const page = host.trace.page({
    ...(ascending ? { after: from } : { before: from }),
    ...(filter.kinds ? { kinds: filter.kinds } : {}),
    ...(filter.conversation === undefined ? {} : { conversation: filter.conversation }),
    ...(filter.errors ? { errors: true } : {}),
    ...(filter.text ? { text: filter.text } : {}),
    limit,
  })
  return {
    found: page.rows.map((call): Item => ({
      row: callRow(call),
      position: call.seq,
      time: Date.parse(call.at) + call.ms,
    })),
    last: page.last,
  }
}

/** Newest first; equal times by id, so the order is total. */
const newer = (a: Item, b: Item) => b.time - a.time || (a.row.id < b.row.id ? 1 : -1)

/**
 * Up to `limit` items of two lists, each in its source's order, taking the head that comes first by `first`: each
 * source gives a prefix of its list, so a cursor per source (its last item taken) resumes without gaps or repeats.
 */
function merge(a: Item[], b: Item[], limit: number, first: (x: Item, y: Item) => number) {
  const taken: Item[] = []
  let i = 0
  let j = 0
  while (taken.length < limit && (i < a.length || j < b.length))
    taken.push(j >= b.length || (i < a.length && first(a[i], b[j]) <= 0) ? a[i++] : b[j++])
  return { taken, a: i, b: j }
}

/**
 * Where a source resumes after `took` of its `found` items: its last item taken, `from` if none, `end` once all are
 * taken. Each source reads one item past the limit, so all taken means nothing further matched.
 */
const resume = (found: Item[], took: number, from: number, end: number) =>
  took === found.length ? end : took ? found[took - 1].position : from

async function stream(host: ExtensionHost, args: Record<string, unknown>) {
  const filter = filterOf(args)
  const limit = args.limit === undefined ? 200 : Number(args.limit)
  if (!Number.isInteger(limit) || limit < 1 || limit > 500)
    throw new Error('Expected limit to be an integer from 1 to 500')
  const before = decode(args.before, 'before')
  const after = decode(args.after, 'after')
  if (before && after) throw new Error('Give before or after, not both')
  const wantEvents = (!filter.sources || filter.sources.includes('event')) && !filter.errors
  const wantCalls = !filter.sources || filter.sources.includes('call')
  // The newest event id, read first so a live follower never skips one appended meanwhile.
  const latest = (await host.eventLog.recent({ limit: 1 }))[0]?.id ?? 0

  if (after) {
    // The oldest rows since the cursor, so a follower that falls behind catches up page by page.
    const fromEvents = wantEvents ? await events(host, filter, after.e, true, limit + 1) : []
    const fromCalls = wantCalls ? calls(host, filter, after.c, true, limit + 1) : undefined
    const end = fromCalls?.last ?? host.trace.page({ limit: 1 }).last
    const merged = merge(fromEvents, fromCalls?.found ?? [], limit, (x, y) => newer(y, x))
    // An event appended after `latest` was read may be among those found.
    const newest = Math.max(after.e, latest, fromEvents.at(-1)?.position ?? 0)
    const head = {
      e: resume(fromEvents, merged.a, after.e, newest),
      c: resume(fromCalls?.found ?? [], merged.b, after.c, Math.max(after.c, end)),
    }
    return { rows: merged.taken.map((item) => item.row).toReversed(), head: encode(head) }
  }

  const start = before ?? { e: latest + 1, c: Number.MAX_SAFE_INTEGER }
  const fromEvents =
    wantEvents && start.e > 0 ? await events(host, filter, start.e, false, limit + 1) : []
  const fromCalls =
    wantCalls && start.c > 0 ? calls(host, filter, start.c, false, limit + 1) : undefined
  const merged = merge(fromEvents, fromCalls?.found ?? [], limit, newer)
  const next = {
    e: resume(fromEvents, merged.a, start.e, 0),
    c: resume(fromCalls?.found ?? [], merged.b, start.c, 0),
  }
  const head = { e: latest, c: fromCalls?.last ?? host.trace.page({ limit: 1 }).last }
  return {
    rows: merged.taken.map((item) => item.row),
    ...(next.e || next.c ? { next: encode(next) } : {}),
    head: encode(head),
  }
}

/** Every event emitted in trace `trace`, oldest first. */
async function traceEvents(host: ExtensionHost, trace: string) {
  const found: SystemRow[] = []
  let before: number | undefined
  for (;;) {
    const page = await host.eventLog.recent({
      ...(before === undefined ? {} : { before }),
      limit: 500,
    })
    for (const event of page) if (event.context?.traceId === trace) found.push(eventRow(event))
    if (page.length < 500) return found.toReversed()
    before = page.at(-1)!.id
  }
}

const node = (call: CallTree): SystemCall => ({
  ...callRow(call),
  ...(call.parent === undefined ? {} : { parent: call.parent }),
  children: call.children.map(node),
})

const QUIET = 20_000
const LANES = 40
const CALLS = 200

/** What a `subagents.started` event says about a conversation, and the work that emitted it. */
type Fact = Omit<Lane, 'conversation' | 'runs' | 'spawn'> & {
  at: string
  context?: EventRecord['context']
}

/**
 * Agent facts by conversation, from `subagents.started` events (newest wins). The parent is the conversation whose
 * work emitted the event (the `subagent` or `branch` call that started it), else the event's own: a branch names the
 * root it forked from, not who asked for it. A standing agent has none.
 */
async function started(host: ExtensionHost) {
  const Started = defineEvent<Record<string, JsonValue>>('subagents.started')
  const facts = new Map<number, Fact>()
  let before: number | undefined
  for (;;) {
    const page = await host.eventLog.recent({
      events: [Started],
      ...(before === undefined ? {} : { before }),
      limit: 500,
    })
    for (const { data, at, context } of page) {
      if (typeof data.id !== 'number' || facts.has(data.id)) continue
      const kind = data.kind
      const caller = context?.conversationId
      const parent =
        kind === 'standing'
          ? undefined
          : caller !== undefined && caller !== data.id
            ? caller
            : typeof data.parent === 'number'
              ? data.parent
              : undefined
      facts.set(data.id, {
        at,
        ...(context ? { context } : {}),
        ...(typeof data.agent === 'string' ? { agent: data.agent } : {}),
        ...(typeof data.model === 'string' ? { model: data.model } : {}),
        ...(kind === 'standing' || kind === 'branch' || kind === 'child' ? { kind } : {}),
        ...(parent === undefined ? {} : { parent }),
      })
    }
    if (page.length < 500) return facts
    before = page.at(-1)!.id
  }
}

type Sent = { from: number; to: number }
/** `board.sent` events between two conversations emitted in `[since, until)`, oldest first. */
async function messages(host: ExtensionHost, since: number, until: number) {
  const Sent = defineEvent<Record<string, JsonValue>>('board.sent')
  const found: EventRecord<Sent>[] = []
  let before: number | undefined
  for (;;) {
    const page = await host.eventLog.recent({
      events: [Sent],
      ...(before === undefined ? {} : { before }),
      limit: 500,
    })
    for (const event of page) {
      const at = Date.parse(event.at)
      if (at < since) return found.toReversed()
      if (at < until && typeof event.data.from === 'number' && typeof event.data.to === 'number')
        found.push(event as EventRecord<Sent>)
    }
    if (page.length < 500) return found.toReversed()
    before = page.at(-1)!.id
  }
}

/** Tool calls that start others: the nearest one before a child's start stands for its spawn when no event says. */
const SPAWNING = new Set(['subagent', 'branch', 'message'])

/**
 * The tool call of conversation `conversation` that call `id` of trace `trace` ran in: the call itself or its nearest
 * tool ancestor. `calls` are the window's tool and model calls by id; the rest of a trace is read once into `trees`.
 */
function ownToolCall(
  host: ExtensionHost,
  byId: Map<string, CallRow>,
  trees: Map<string, Map<string, CallRow>>,
  conversation: number,
  id: string,
  trace: string | undefined,
) {
  const own = (call: CallRow | undefined) =>
    call?.kind === 'tool' && call.conversation === conversation ? call : undefined
  if (own(byId.get(id)) || trace === undefined) return own(byId.get(id))
  let tree = trees.get(trace)
  if (!tree) {
    tree = new Map(host.trace.query({ trace, limit: 1000 }).map((call) => [call.id, call]))
    trees.set(trace, tree)
  }
  for (let call = tree.get(id); call; call = call.parent ? tree.get(call.parent) : undefined)
    if (own(call)) return call
  return undefined
}

/** Conversations with a live foreground task. */
async function busy(host: ExtensionHost) {
  const graph = await host.harness().watchTaskGraph(BACKGROUND_CONTEXT)
  await graph.stop()
  return new Set(
    Object.values(graph.value.tasks)
      .filter((task) => !task.background)
      .map((task) => task.conversationId as number),
  )
}

function time(value: unknown, name: string) {
  if (value === undefined) return undefined
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN
  if (Number.isNaN(parsed)) throw new Error(`Expected ${name} to be an ISO time`)
  return parsed
}

/** The lanes of `args`'s window as of `clock`; exported for tests, which set the clock. */
export async function lanes(
  host: ExtensionHost,
  args: Record<string, unknown>,
  clock = Date.now(),
) {
  const until = time(args.until, 'until') ?? clock
  const since = time(args.since, 'since') ?? until - 30 * 60_000
  if (since >= until) throw new Error('Expected since before until')
  // Each conversation's tool and model calls in the window, by start time.
  const byConversation = new Map<number, CallRow[]>()
  let after = 0
  for (;;) {
    const { rows } = host.trace.page({ after, since, until, kinds: ['tool', 'model'], limit: 1000 })
    for (const call of rows) {
      if (call.conversation === undefined) continue
      const list = byConversation.get(call.conversation)
      if (list) list.push(call)
      else byConversation.set(call.conversation, [call])
    }
    if (rows.length < 1000) break
    after = rows.at(-1)!.seq
  }
  const live = until >= clock ? await busy(host) : new Set<number>()
  const facts = byConversation.size ? await started(host) : new Map<number, Fact>()
  // Conversations without an event fall back to their owner or the conversation they branched from.
  const owners = new Map<number, number>()
  if (byConversation.size)
    for (const summary of host.conversations()) {
      const owner = summary.parentConversationId ?? summary.branchOf?.conversationId
      if (owner !== undefined) owners.set(summary.id, owner)
    }
  const parentOf = (conversation: number) =>
    facts.get(conversation)?.parent ?? owners.get(conversation)
  const all = [...byConversation].map(([conversation, found]) => {
    found.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    const runs: { start: number; end: number; calls: CallRow[] }[] = []
    for (const call of found) {
      const start = Date.parse(call.at)
      const run = runs.at(-1)
      if (run && start - run.end <= QUIET) {
        run.calls.push(call)
        run.end = Math.max(run.end, start + call.ms)
      } else runs.push({ start, end: start + call.ms, calls: [call] })
    }
    const last = runs.at(-1)!
    const open = until >= clock && (clock - last.end < QUIET || live.has(conversation))
    const lane: Lane = {
      conversation,
      runs: runs.map((run) => ({
        start: new Date(run.start).toISOString(),
        ...(open && run === last ? {} : { end: new Date(run.end).toISOString() }),
        ok: run.calls.every((call) => call.ok),
        calls: run.calls.slice(0, CALLS).map((call) => ({
          at: call.at,
          ms: call.ms,
          kind: call.kind,
          name: call.name,
          ok: call.ok,
          trace: call.trace,
        })),
        ...(run.calls.length > CALLS ? { more: run.calls.length - CALLS } : {}),
      })),
    }
    return { lane, active: open ? Number.POSITIVE_INFINITY : last.end }
  })
  all.sort((a, b) => b.active - a.active || b.lane.conversation - a.lane.conversation)
  // The most recently active lanes, each with its parent so its subtree hangs where it belongs: a parent that worked
  // brings its lane along, one that did not is a lane without runs. One hop up from each lane that worked, never the
  // whole ancestry: an active lane already listed as another's parent still brings its own parent.
  const worked = new Map(all.map((item) => [item.lane.conversation, item.lane]))
  const listed = new Map<number, Lane>()
  for (const { lane } of all) {
    const add = listed.has(lane.conversation) ? [] : [lane]
    const parent = parentOf(lane.conversation)
    if (parent !== undefined && parent !== lane.conversation && !listed.has(parent))
      add.push(worked.get(parent) ?? { conversation: parent, runs: [] })
    if (add.length > 0 && listed.size + add.length <= LANES)
      for (const item of add) listed.set(item.conversation, item)
  }
  const more = all.filter((item) => !listed.has(item.lane.conversation)).length
  const byId = new Map<string, CallRow>()
  for (const found of byConversation.values()) for (const call of found) byId.set(call.id, call)
  const trees = new Map<string, Map<string, CallRow>>()
  const toolCall = (conversation: number, id: string, trace: string | undefined) =>
    ownToolCall(host, byId, trees, conversation, id, trace)
  const lanesOut = [...listed.values()].map((lane): Lane => {
    const fact = facts.get(lane.conversation)
    const parent = parentOf(lane.conversation)
    const spawn =
      parent !== undefined && listed.has(parent) ? spawnOf(lane, parent, fact) : undefined
    return {
      conversation: lane.conversation,
      ...(fact?.agent === undefined ? {} : { agent: fact.agent }),
      ...(fact?.model === undefined ? {} : { model: fact.model }),
      ...(fact?.kind === undefined ? {} : { kind: fact.kind }),
      ...(parent !== undefined && listed.has(parent) ? { parent } : {}),
      ...(spawn ? { spawn } : {}),
      runs: lane.runs,
    }
  })
  const links: LaneLink[] = []
  if (listed.size)
    for (const event of await messages(host, since, until)) {
      const { from, to } = event.data
      if (!listed.has(from) || !listed.has(to) || from === to) continue
      const call =
        event.context?.parentCall === undefined
          ? undefined
          : toolCall(from, event.context.parentCall, event.context.traceId)
      links.push({
        from,
        to,
        ...(call ? { call: call.id } : {}),
        at: call?.at ?? event.at,
        kind: 'message',
      })
    }
  return {
    now: new Date(clock).toISOString(),
    lanes: lanesOut,
    links,
    ...(more ? { more } : {}),
  }

  /**
   * Where `lane` started in `parent`'s lane: the call its event names, else the parent's last spawning tool call before
   * the lane was created (its event) or first worked.
   */
  function spawnOf(lane: Lane, parent: number, fact: Fact | undefined): LaneSpawn | undefined {
    const context = fact?.context
    if (context?.parentCall !== undefined && context.conversationId === parent) {
      const call = toolCall(parent, context.parentCall, context.traceId)
      if (call) return { call: call.id, at: call.at }
    }
    const first = lane.runs[0]
    const bound = fact ? Date.parse(fact.at) : first && Date.parse(first.start)
    if (bound === undefined) return undefined
    const call = byConversation
      .get(parent)
      ?.findLast(
        (candidate) =>
          candidate.kind === 'tool' &&
          SPAWNING.has(candidate.name) &&
          Date.parse(candidate.at) <= bound,
      )
    return call && { call: call.id, at: call.at, inferred: true }
  }
}

const record = (args: unknown): Record<string, unknown> =>
  args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {}

/**
 * The surface polls these every few seconds with moving cursors, so no two calls repeat: the trace counts their
 * successful calls instead of writing them (`polls()`); failures are written.
 */
export const pollActions = ['stream', 'lanes', 'tree', 'polls']

/** The view the last `ui.navigated` recorded, `<surface>:<conversation>`, so repeats are dropped. */
const LastView = defineDoc<{ key?: string }>({
  kind: 'system.last-view',
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})

/** Only the browser reports where the user is; an agent calling it would make up navigation. */
export const userActions = ['navigated']

export const actions = {
  /** Record a `ui.navigated` event, unless it repeats the last one: other tabs and reloads report the same view. */
  navigated: implementAction(NavigatedAction, async (args, { host, device }) => {
    const { surface, conversation } = record(args)
    if (typeof surface !== 'string' || !surface || surface.length > 64)
      throw new Error('Expected { surface }')
    if (conversation !== undefined && !Number.isSafeInteger(conversation))
      throw new Error('Expected conversation to be an integer')
    const data = {
      surface,
      ...(conversation === undefined ? {} : { conversation: conversation as number }),
      ...device,
    }
    const key = `${surface}:${data.conversation ?? ''}`
    // Compared and recorded in one commit, so two tabs reporting the same view record it once.
    return host.harness().commit(async (tx) => {
      const last = await tx.doc(LastView, ROOT_CONVERSATION_ID)
      if (last.key === key) return { recorded: false }
      last.key = key
      await host.emit(tx, NavigatedEvent, data)
      return { recorded: true }
    }, BACKGROUND_CONTEXT)
  }),
  stream: implementAction(StreamAction, (args, { host }) => stream(host, record(args))),
  lanes: implementAction(LanesAction, (args, { host }) => lanes(host, record(args))),
  polls: implementAction(PollsAction, (_args, { host }) => ({ polls: host.trace.polls() })),
  tree: implementAction(TreeAction, async (args, { host }) => {
    const trace = record(args).trace
    if (typeof trace !== 'string' || !trace) throw new Error('Expected { trace }')
    return { calls: host.trace.tree(trace).map(node), events: await traceEvents(host, trace) }
  }),
}

export default { name: 'system' }
