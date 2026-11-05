// Durable events: the log is one ownerless conversation that never runs, and an event is a typed entry in it, so entry
// ids give one global order and history, search and sync cover it. `emit` appends in the caller's transaction, so the
// event exists exactly when the state change it describes does. A reactor's cursor advances in the transaction its
// handler writes in: its `tx` writes happen exactly once per event across crashes, reloads and failures; side effects
// outside `tx` (files, processes, network) are at least once.
import type { JsonValue } from '@earendil-works/chord'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { defineDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId, EntryId, EntryRecord, Harness, Tx } from '@earendil-works/pi-durable'
import { onCommit } from '../lib/commits.ts'
import { EVENT_FEED, EVENT_FEED_SIZE, NoticeEvent } from '../shared/events.ts'
import type { EventContext, EventData, EventRecord, EventToken } from '../shared/events.ts'
import { Metadata } from './metadata.ts'
import { traceContext } from './trace.ts'
import type { CallTrace } from './trace.ts'

/** Where the log lives and how far each reactor has read; on the root, next to other project-wide indexes. */
export const EventLog = defineDoc<{ conversation?: number; cursors: Record<string, number> }>({
  kind: 'ultimate.events',
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ cursors: {} }),
})

/** The newest events, oldest first, for the browser (`useEvents()`); on the root. */
export const EventFeed = defineDoc<{ events: EventRecord[] }>({
  kind: EVENT_FEED,
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ events: [] }),
})

export type Reactor<D extends JsonValue> = (tx: Tx, event: EventRecord<D>) => void | Promise<void>
export interface ReactorStatus {
  name: string
  events: string[]
  /** The last log entry the reactor has passed. */
  cursor: number
  /** Matching events after the cursor. */
  lag: number
  running: boolean
  /** The latest failure; cleared by the next successful step. The failed event stays pending and is retried. */
  failure?: { error: string; at: string; entryId?: number }
}

export interface ReactOptions {
  /** Where a reactor without a cursor starts: the start of the log (default), or after its newest event. */
  from?: 'start' | 'now'
}

/** What the extension host offers; `react` is facet-scoped and named `<extension>/<name>`. */
export interface EventHost {
  /** Append event `event` with `data` inside `tx`: it commits or rolls back with the caller's writes. */
  emit<D extends JsonValue>(tx: Tx, event: EventToken<D>, data: D): Promise<EventRecord<D>>
  /**
   * Run `handler` once for every event of `events` after the reactor's cursor, oldest first: those emitted before it
   * started, then each new one, serially per name. Each event commits with the cursor advance in one transaction; a
   * throw rolls both back and the event is retried on the next matching commit or harness open. Runs while the harness
   * is open and the facet installed; a facet reload under the same name continues from the cursor. With `from: 'now'`, a
   * reactor that has no cursor yet starts after the newest event instead of at the start of the log.
   */
  react<T extends EventToken>(
    name: string,
    events: readonly T[],
    handler: Reactor<EventData<T>>,
    options?: ReactOptions,
  ): void
  eventLog: {
    /** Newest first (oldest first with `order: 'ascending'`), plain copies; `since` and `before` are exclusive event ids. */
    recent<T extends EventToken = EventToken>(options?: {
      events?: readonly T[]
      since?: number
      before?: number
      order?: 'ascending' | 'descending'
      limit?: number
    }): Promise<EventRecord<EventData<T>>[]>
    reactors(): Promise<ReactorStatus[]>
  }
}

/** The trace context of the work that emits, stamped on every event. */
function currentContext(): EventContext | undefined {
  const trace = traceContext()
  return trace && { ...trace }
}

const record = (entry: EntryRecord): EventRecord => {
  const envelope = entry.data as Pick<EventRecord, 'v' | 'at' | 'data' | 'context'>
  return structuredClone({
    id: entry.id,
    name: entry.kind.slice('event.'.length),
    kind: entry.kind,
    ...envelope,
  })
}

/** Labels the log conversation, which conversation lists leave out; it stays readable by id. */
export const EVENT_LOG_LABEL = 'events'

async function logOf(tx: Tx) {
  const index = await tx.doc(EventLog, ROOT_CONVERSATION_ID)
  if (index.conversation === undefined) {
    const { id } = await tx.createConversation({ ownership: { kind: 'ownerless' } })
    Object.assign(await tx.doc(Metadata, id), { title: 'Events', label: EVENT_LOG_LABEL })
    index.conversation = id
  }
  return index.conversation as ConversationId
}

export async function emit<D extends JsonValue>(tx: Tx, event: EventToken<D>, data: D) {
  const stamp = currentContext()
  const entry = await tx.appendEntry(await logOf(tx), {
    kind: event.kind,
    data: {
      v: event.version,
      at: new Date().toISOString(),
      data,
      ...(stamp ? { context: stamp } : {}),
    },
  })
  const emitted = record(entry) as EventRecord<D>
  const feed = (await tx.doc(EventFeed, ROOT_CONVERSATION_ID)).events
  feed.push(emitted)
  if (feed.length > EVENT_FEED_SIZE) feed.splice(0, feed.length - EVENT_FEED_SIZE)
  return emitted
}

/** Scan the log after entry `after`, oldest first, until `visit` returns true. */
async function scan(
  tx: Tx,
  log: ConversationId,
  after: number,
  visit: (entry: EntryRecord) => boolean,
) {
  let cursor: Parameters<Tx['scanEntries']>[2]
  do {
    const page = await tx.scanEntries(
      { conversationId: log, minEntryId: (after + 1) as EntryId, order: 'ascending' },
      256,
      cursor,
    )
    for (const entry of page.items) if (visit(entry)) return
    cursor = page.next
  } while (cursor)
}

/**
 * Events, reactors and recorded notices of one extension host. `keep` tells the call trace to write the call that emits
 * (`CallTrace['keep']`): its reactors continue its trace and need it as their parent, even when it repeats a poll.
 */
export function eventLog(
  harness: () => Harness,
  trace: CallTrace['run'],
  keep: CallTrace['keep'] = () => {},
) {
  type Active = { kinds: Set<string>; handler: Reactor<JsonValue>; from: 'start' | 'now' }
  const reactors = new Map<
    string,
    {
      /** The registration that runs, while one does. */
      active?: Active
      kinds: Set<string>
      chain: Promise<void>
      failure?: ReactorStatus['failure']
    }
  >()

  /** Handle the reactor's next pending event, one per transaction, until none is left or one fails. */
  function drain(name: string) {
    const state = reactors.get(name)!
    state.chain = state.chain.then(async () => {
      for (;;) {
        const active = state.active
        if (!active) return
        let attempted: number | undefined
        try {
          const handled = await harness().commit(async (tx) => {
            const index = await tx.doc(EventLog, ROOT_CONVERSATION_ID)
            if (index.cursors[name] === undefined && active.from === 'now') {
              // A new reactor that skips the past starts after the newest event, handling none.
              const newest =
                index.conversation === undefined
                  ? undefined
                  : (
                      await tx.scanEntries(
                        { conversationId: index.conversation as ConversationId },
                        1,
                      )
                    ).items[0]
              index.cursors[name] = newest?.id ?? 0
              return false
            }
            if (index.conversation === undefined) return false
            const after = index.cursors[name] ?? 0
            let pending: EntryRecord | undefined
            let last = after
            await scan(tx, index.conversation as ConversationId, after, (entry) => {
              last = entry.id
              if (active.kinds.has(entry.kind)) pending = entry
              return pending !== undefined
            })
            if (pending) {
              attempted = pending.id
              const event = record(pending)
              // The emitter's context, not the drain's: commit listeners run in whichever work committed.
              await trace(
                {
                  kind: 'reactor',
                  caller: event.name,
                  callee: name.split('/')[0],
                  name,
                  args: { event: event.id },
                },
                () => active.handler(tx, event),
                event.context ?? null,
              )
            }
            if (last !== after) index.cursors[name] = last
            return pending !== undefined
          }, context)
          state.failure = undefined
          if (!handled) return
        } catch (error) {
          // The transaction rolled back the handler's writes and the cursor: the event stays pending.
          state.failure = { error: String(error), at: new Date().toISOString(), entryId: attempted }
          return
        }
      }
    })
  }

  return {
    emit: <D extends JsonValue>(tx: Tx, event: EventToken<D>, data: D) => {
      keep(traceContext())
      return emit(tx, event, data)
    },
    /** Record a notice of `extension` as an event; failures only log, so they cannot raise more notices. */
    notice(extension: string, message: string) {
      Promise.resolve()
        .then(() =>
          harness().commit(
            (tx) => emit(tx, NoticeEvent, { extension, message, level: 'warning' }),
            context,
          ),
        )
        .catch((error: unknown) => console.error('Recording a notice failed:', error))
    },
    /** A reactor `name` for `events`: `start` on each harness open, `stop` on release and facet disposal. */
    reactor<T extends EventToken>(
      name: string,
      events: readonly T[],
      handler: Reactor<EventData<T>>,
      options: ReactOptions = {},
    ) {
      const active: Active = {
        kinds: new Set(events.map((event) => event.kind)),
        handler: handler as Reactor<JsonValue>,
        from: options.from ?? 'start',
      }
      if (!reactors.has(name)) reactors.set(name, { kinds: active.kinds, chain: Promise.resolve() })
      const state = reactors.get(name)!
      let unsubscribe: (() => void) | undefined
      const stop = () => {
        unsubscribe?.()
        unsubscribe = undefined
        if (state.active === active) state.active = undefined
        return state.chain
      }
      return {
        start: async () => {
          await stop()
          state.active = active
          state.kinds = active.kinds
          unsubscribe = onCommit(harness(), (publication) => {
            if (
              publication.changes.some(
                (change) => change.type === 'entry' && active.kinds.has(change.value.kind),
              )
            )
              drain(name)
          })
          drain(name)
        },
        stop,
      }
    },
    eventLog: { recent, reactors: statuses } satisfies EventHost['eventLog'],
  }

  async function recent<T extends EventToken = EventToken>(
    options: {
      events?: readonly T[]
      since?: number
      before?: number
      order?: 'ascending' | 'descending'
      limit?: number
    } = {},
  ) {
    type D = EventData<T>
    const log = (await harness().snapshot(EventLog, ROOT_CONVERSATION_ID, context))?.conversation
    if (log === undefined) return []
    const kinds = options.events && new Set(options.events.map((event) => event.kind))
    const limit = options.limit ?? 20
    return harness().commit(async (tx) => {
      const found: EventRecord<D>[] = []
      let cursor: Parameters<Tx['scanEntries']>[2]
      do {
        const page = await tx.scanEntries(
          {
            conversationId: log as ConversationId,
            ...(options.since === undefined ? {} : { minEntryId: (options.since + 1) as EntryId }),
            ...(options.before === undefined
              ? {}
              : { maxEntryId: (options.before - 1) as EntryId }),
            order: options.order ?? 'descending',
          },
          256,
          cursor,
        )
        for (const entry of page.items) {
          if (!(kinds ? kinds.has(entry.kind) : entry.kind.startsWith('event.'))) continue
          found.push(record(entry) as EventRecord<D>)
          if (found.length >= limit) return found
        }
        cursor = page.next
      } while (cursor)
      return found
    }, context)
  }

  async function statuses(): Promise<ReactorStatus[]> {
    const index = await harness().snapshot(EventLog, ROOT_CONVERSATION_ID, context)
    return harness().commit(async (tx) => {
      const list: ReactorStatus[] = []
      for (const [name, state] of reactors) {
        const cursor = index?.cursors[name] ?? 0
        let lag = 0
        if (index?.conversation !== undefined)
          await scan(tx, index.conversation as ConversationId, cursor, (entry) => {
            if (state.kinds.has(entry.kind)) lag++
            return false
          })
        list.push({
          name,
          events: [...state.kinds].map((kind) => kind.slice('event.'.length)),
          cursor,
          lag,
          running: state.active !== undefined,
          ...(state.failure ? { failure: state.failure } : {}),
        })
      }
      return list
    }, context)
  }
}
