/**
 * System in the browser: one stream of everything Ultimate records (durable events and the call trace), paged and
 * filtered, and the call tree of one trace with its events. Browser-safe.
 */
import type { ConversationId } from '@earendil-works/pi-durable'
import { actionRef } from '../../shared/extension-api.ts'

/** One recorded thing: a durable event or a traced call, in one shape. */
export type SystemRow = {
  /** `e<event id>` for an event, the call id for a call. */
  id: string
  source: 'event' | 'call'
  /** ISO time: when the event was emitted, or when the call started. */
  at: string
  /** `event` for an event; the call kind (`service`, `action`, `reactor`, `tool`, `model`, …) for a call. */
  kind: string
  /** The event name (`workspaces.landed`) or the call name (`alpha/go`, `bash`). */
  name: string
  conversation?: ConversationId
  trace?: string
  /** False for a failed call; events are always ok. */
  ok: boolean
  /** A call's duration in milliseconds. */
  ms?: number
  error?: string
  /** One short line: the event's data, or `caller → callee` and the call's arguments (redacted by the trace). */
  summary: string
}

/**
 * Filters of a stream: `sources` keeps events, calls or both (default both); `kinds` keeps event names and call kinds
 * (`['workspaces.landed', 'tool']`); `conversation` keeps rows of that conversation; `errors` keeps failed calls
 * only; `text` keeps rows whose name, caller, callee, arguments, error or event data contain it.
 */
export type SystemFilter = {
  sources?: ('event' | 'call')[]
  kinds?: string[]
  conversation?: ConversationId
  errors?: boolean
  text?: string
}

/**
 * `{ before?, after?, limit?, ...filter }` → `{ rows, next?, head }`: at most `limit` (default 200, at most 500)
 * matching rows, newest first, events and calls merged by time (a call by when it finished, as the trace records it).
 * Without a cursor, the newest rows. `before: next` pages back without gaps or repeats; `next` is absent once nothing
 * older is left. `after: head` follows live: the rows recorded since, newest first, at most `limit` of the oldest
 * ones, with a new `head` to follow from. Cursors are opaque; reuse them only with the same filter.
 */
export const StreamAction = actionRef<
  SystemFilter & { before?: string; after?: string; limit?: number },
  { rows: SystemRow[]; next?: string; head: string }
>('system', 'stream')

/** One call inside a run: a tool call, or a model call (kind `model`); `trace` opens its tree with `tree`. */
export type LaneCall = {
  at: string
  ms: number
  kind: string
  name: string
  ok: boolean
  trace: string
}
/**
 * A stretch of work in one conversation: calls with at most 20 s of quiet between them. `end` is absent while the run
 * is open (its last call ended under 20 s ago, or the conversation has a live task). `more` counts calls past the 200
 * kept, which are the newest.
 */
export type LaneRun = { start: string; end?: string; ok: boolean; calls: LaneCall[]; more?: number }
/**
 * Where a lane was started: the tool call in its parent's lane that did it (`call`, its trace id) and when it started.
 * `inferred` when no event names the call and it is the parent's last `subagent`, `branch` or `message` call before
 * the lane's first call.
 */
export type LaneSpawn = { call?: string; at: string; inferred?: true }
/**
 * One conversation's runs, oldest first; agent, model and kind from its `subagents.started` event, if any. `parent` is
 * the conversation that started it: the one whose tool call emitted that event, else the event's parent, else its
 * owner or the conversation it branched from. Titles are the browser's to resolve (`ConversationRef`).
 */
export type Lane = {
  conversation: ConversationId
  agent?: string
  model?: string
  kind?: 'standing' | 'branch' | 'child'
  parent?: ConversationId
  /** Present when the parent is among the lanes. */
  spawn?: LaneSpawn
  runs: LaneRun[]
}
/** A message from one lane's conversation to another's, sent at `at` by tool call `call`. */
export type LaneLink = {
  from: ConversationId
  to: ConversationId
  call?: string
  at: string
  kind: 'message'
}

/**
 * `{ since?, until?, windowMs? }` (ISO; default the last `windowMs`, else 30 minutes, up to now, `since` rounded down
 * to the minute when `windowMs` sets it) → `{ now, lanes, links, more? }`: a lane for each
 * conversation with tool or model calls in the window, most recently active first, at most 40 together with the
 * parents they need (a parent without calls in the window has no runs); `more` counts the lanes left out. `links` are
 * the messages between listed lanes sent in the window, oldest first.
 */
export const LanesAction = actionRef<
  { since?: string; until?: string; windowMs?: number },
  { now: string; lanes: Lane[]; links: LaneLink[]; more?: number }
>('system', 'lanes')

/**
 * No arguments → `{ polls }`: the successful action and service calls the trace did not write because they repeated
 * one written within the last minute (UI polls), by name with their count since `since` (ISO), most first.
 */
export const PollsAction = actionRef<
  null,
  { polls: { name: string; count: number; since: string }[] }
>('system', 'polls')

/** A traced call with the calls it made, in start order. */
export type SystemCall = SystemRow & { parent?: string; children: SystemCall[] }

/**
 * `{ surface, conversation? }` → `{ recorded }`: the browser reports what the user looks at, and a `ui.navigated`
 * event is recorded unless it repeats the last one (`recorded: false`).
 */
export const NavigatedAction = actionRef<
  { surface: string; conversation?: ConversationId },
  { recorded: boolean }
>('system', 'navigated')

/**
 * `{ trace }` → `{ calls, events }`: the call tree of trace `trace` (roots in start order, at most 5000 calls) and
 * the events emitted in it, oldest first.
 */
export const TreeAction = actionRef<
  { trace: string },
  { calls: SystemCall[]; events: SystemRow[] }
>('system', 'tree')
