import { parseEntryId, offsetEntryId } from '../lib/ids.ts'
import type { EntryId, ConversationId, EntryRecord, Harness, Tx } from '@earendil-works/pi-durable'
import type { JsonValue } from '@earendil-works/chord/json'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { defineDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { onCommit } from '../lib/commits.ts'
import { inProcess } from '../lib/errors.ts'
import { EVENT_FEED, EVENT_FEED_SIZE, NoticeEvent } from '../shared/events.ts'
import type { EventContext, EventData, EventRecord, EventToken } from '../shared/events.ts'
import { Metadata } from './metadata.ts'
import { traceContext } from './trace.ts'
import type { CallTrace } from './trace.ts'

export const EventLog = defineDoc<{
  conversation?: ConversationId
  cursors: Record<string, EntryId>
}>({
  kind: 'ultimate.events',
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ cursors: {} }),
})

export const EventFeed = defineDoc<{ events: EventRecord[] }>({
  kind: EVENT_FEED,
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ events: [] }),
})

type CursorAtomicWrites = Tx
type AtLeastOnceExternalEffects<D extends JsonValue> = (
  tx: CursorAtomicWrites,
  event: EventRecord<D>,
) => void | Promise<void>

export type Reactor<D extends JsonValue> = AtLeastOnceExternalEffects<D>
export interface ReactorStatus {
  name: string
  events: string[]
  cursor: EntryId
  lag: number
  running: boolean
  failure?: { error: string; at: string; entryId?: EntryId }
}

export interface ReactOptions {
  from?: 'start' | 'now'
}

export interface EventHost {
  emit<D extends JsonValue>(tx: Tx, event: EventToken<D>, data: D): Promise<EventRecord<D>>
  react<T extends EventToken>(
    name: string,
    events: readonly T[],
    handler: Reactor<EventData<T>>,
    options?: ReactOptions,
  ): void
  eventLog: {
    recent<T extends EventToken = EventToken>(options?: {
      events?: readonly T[]
      since?: EntryId
      before?: EntryId
      order?: 'ascending' | 'descending'
      limit?: number
    }): Promise<EventRecord<EventData<T>>[]>
    reactors(): Promise<ReactorStatus[]>
  }
}

function currentContext(): EventContext | undefined {
  const trace = traceContext()
  return trace && { ...trace }
}

const record = (entry: EntryRecord): EventRecord => {
  const envelope = entry.data as Pick<EventRecord, 'v' | 'at' | 'data' | 'context' | 'fails'>
  return structuredClone({
    id: entry.id,
    name: entry.kind.slice('event.'.length),
    kind: entry.kind,
    ...envelope,
  })
}

export const EVENT_LOG_LABEL = 'events'

async function logOf(tx: Tx) {
  const index = await tx.doc(EventLog, ROOT_CONVERSATION_ID)
  if (index.conversation === undefined) {
    const { id: ownerlessLogConversationId } = await tx.createConversation({
      ownership: { kind: 'ownerless' },
    })
    Object.assign(await tx.doc(Metadata, ownerlessLogConversationId), {
      title: 'Events',
      label: EVENT_LOG_LABEL,
    })
    index.conversation = ownerlessLogConversationId
  }
  return index.conversation
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
      ...(event.fails ? { fails: event.fails } : {}),
    },
  })
  const emitted = record(entry) as EventRecord<D>
  const feed = (await tx.doc(EventFeed, ROOT_CONVERSATION_ID)).events
  feed.push(emitted)
  if (feed.length > EVENT_FEED_SIZE) feed.splice(0, feed.length - EVENT_FEED_SIZE)
  return emitted
}

async function scan(
  tx: Tx,
  log: ConversationId,
  after: EntryId,
  visit: (entry: EntryRecord) => boolean,
) {
  let cursor: Parameters<Tx['scanEntries']>[2]
  do {
    const page = await tx.scanEntries(
      { conversationId: log, minEntryId: offsetEntryId(after, 1), order: 'ascending' },
      256,
      cursor,
    )
    for (const entry of page.items) if (visit(entry)) return
    cursor = page.next
  } while (cursor)
}

export function eventLog(
  harness: () => Harness,
  trace: CallTrace['run'],
  keepEmittingCallForFutureReactors: CallTrace['keep'] = () => {},
) {
  type Active = { kinds: Set<string>; handler: Reactor<JsonValue>; from: 'start' | 'now' }
  const reactors = new Map<
    string,
    {
      active?: Active
      kinds: Set<string>
      chain: Promise<void>
      failure?: ReactorStatus['failure']
    }
  >()

  function drain(name: string) {
    const state = reactors.get(name)!
    state.chain = state.chain.then(async () => {
      for (;;) {
        const active = state.active
        if (!active) return
        let attemptedUncommittedEventId: EntryId | undefined
        try {
          const handled = await harness().commit(async function handleEventAtomically(tx) {
            const index = await tx.doc(EventLog, ROOT_CONVERSATION_ID)
            if (index.cursors[name] === undefined && active.from === 'now') {
              const newest =
                index.conversation === undefined
                  ? undefined
                  : (await tx.scanEntries({ conversationId: index.conversation }, 1)).items[0]
              index.cursors[name] = newest?.id ?? parseEntryId(0)
              return false
            }
            if (index.conversation === undefined) return false
            const after = index.cursors[name] ?? parseEntryId(0)
            let pending: EntryRecord | undefined
            let last = after
            await scan(tx, index.conversation, after, (entry) => {
              last = entry.id
              if (active.kinds.has(entry.kind)) pending = entry
              return pending !== undefined
            })
            if (pending) {
              attemptedUncommittedEventId = pending.id
              const event = record(pending)
              const emitterContextNotCommitListener = event.context ?? null
              await trace(
                {
                  kind: 'reactor',
                  caller: event.name,
                  callee: name.split('/')[0],
                  name,
                  args: { event: event.id },
                },
                () => active.handler(tx, event),
                emitterContextNotCommitListener,
              )
            }
            if (last !== after) index.cursors[name] = last
            return pending !== undefined
          }, context)
          state.failure = undefined
          if (!handled) return
        } catch (error) {
          state.failure = {
            error: String(error),
            at: new Date().toISOString(),
            entryId: attemptedUncommittedEventId,
          }
          return
        }
      }
    })
  }

  return {
    emit: <D extends JsonValue>(tx: Tx, event: EventToken<D>, data: D) => {
      keepEmittingCallForFutureReactors(traceContext())
      return emit(tx, event, data)
    },
    notice(extension: string, message: string) {
      inProcess(
        'a notice is advisory and also printed',
        Promise.resolve()
          .then(() =>
            harness().commit(
              (tx) => emit(tx, NoticeEvent, { extension, message, level: 'warning' }),
              context,
            ),
          )
          .catch((error: unknown) => console.error('Recording a notice failed:', error)),
      )
    },
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
      since?: EntryId
      before?: EntryId
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
            conversationId: log,
            ...(options.since === undefined ? {} : { minEntryId: offsetEntryId(options.since, 1) }),
            ...(options.before === undefined
              ? {}
              : { maxEntryId: offsetEntryId(options.before, -1) }),
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
        const cursor = index?.cursors[name] ?? parseEntryId(0)
        let lag = 0
        if (index?.conversation !== undefined)
          await scan(tx, index.conversation, cursor, (entry) => {
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
