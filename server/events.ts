import { parseEntryId, offsetEntryId } from '../lib/ids.shared.ts'
import type {
  ConversationId,
  Cursor,
  EntryId,
  EntryRecord,
  Harness,
  Storage,
  Tx,
} from '@earendil-works/pi-durable'
import type { JsonValue } from '@earendil-works/chord/json'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { isDeepStrictEqual } from 'node:util'
import { defineDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { onCommit } from '../lib/commits.ts'
import { inProcess } from '../lib/errors.shared.ts'
import { retryAfter } from '../lib/timers.shared.ts'
import type { Cancel } from '../lib/timers.shared.ts'
import { EVENT_FEED, EVENT_FEED_SIZE, NoticeEvent } from '../shared/events.ts'
import type {
  ChangedEvent,
  EventContext,
  EventData,
  EventRecord,
  EventToken,
  UiAttribution,
} from '../shared/events.ts'
import { Metadata } from './metadata.ts'
import { traceContext } from './trace.ts'
import type { CallTrace } from './trace.ts'
import { checkpointEvery } from '../shared/checkpoint.ts'

type EventIndex = { conversation?: ConversationId; cursors: Record<string, EntryId> }

export const EventLog = defineDoc<EventIndex>({
  kind: 'ultimate.events',
  checkpointWhen: checkpointEvery(100),
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ cursors: {} }),
})

export const EventFeed = defineDoc<{ events: EventRecord[] }>({
  kind: EVENT_FEED,
  checkpointWhen: checkpointEvery(100),
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
  from?: 'start' | 'now' | { cursorOf: string }
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

const withheld = (value: JsonValue) =>
  value === null || typeof value === 'boolean' || typeof value === 'number' ? value : '[value]'

export function uiChange(
  by: UiAttribution,
  change: { key: string; value?: JsonValue; previous?: JsonValue; conversation?: ConversationId },
): EventData<typeof ChangedEvent> | undefined {
  const { key, value, previous, conversation } = change
  if (key.startsWith('shell.') || by.source === 'app' || isDeepStrictEqual(value, previous))
    return undefined
  return {
    key,
    ...(value === undefined ? {} : { value: withheld(value) }),
    ...(previous === undefined ? {} : { previous: withheld(previous) }),
    ...(conversation === undefined ? {} : { conversation }),
    ...by,
  }
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

type StatusReader = {
  index: () => Promise<EventIndex | undefined>
  scanEntries: Storage['scanEntries']
}

export function eventStatusReader(
  storage: Pick<Storage, 'findDocument' | 'document' | 'scanEntries'>,
): StatusReader {
  return {
    index: async () => {
      const doc = await storage.findDocument(
        {
          kind: EventLog.definition.kind,
          scope: { kind: 'conversation', conversationId: ROOT_CONVERSATION_ID },
        },
        'current',
        context,
      )
      if (!doc) return undefined
      const stored = await storage.document(doc.id, 'current', context)
      return stored?.value as EventIndex | undefined
    },
    scanEntries: storage.scanEntries.bind(storage),
  }
}

async function scan(
  entries: Storage['scanEntries'],
  conversationId: ConversationId,
  after: EntryId,
  visit: (entry: EntryRecord) => boolean,
) {
  let cursor: Cursor | undefined
  do {
    const page = await entries(
      { conversationId, minEntryId: offsetEntryId(after, 1), order: 'ascending' },
      256,
      cursor,
      context,
    )
    for (const entry of page.items) if (visit(entry)) return
    cursor = page.next
  } while (cursor)
}

export function eventLog(
  harness: () => Harness,
  readStatus: () => StatusReader,
  trace: CallTrace['run'],
  keepEmittingCallForFutureReactors: CallTrace['keep'] = () => {},
) {
  type Active = { kinds: Set<string>; handler: Reactor<JsonValue> }
  const initialRetryDelay = 1_000
  const reactors = new Map<
    string,
    {
      active?: Active
      kinds: Set<string>
      chain: Promise<void>
      queued: boolean
      cancelRetry?: Cancel
      retryDelay: number
      failure?: ReactorStatus['failure']
    }
  >()

  function drain(name: string) {
    const state = reactors.get(name)!
    if (state.queued || state.cancelRetry) return
    state.queued = true
    state.chain = state.chain.then(async () => {
      state.queued = false
      if (state.cancelRetry) return
      for (;;) {
        const active = state.active
        if (!active) return
        let attemptedUncommittedEventId: EntryId | undefined
        try {
          const handled = await harness().commit(async function handleEventAtomically(tx) {
            const index = await tx.doc(EventLog, ROOT_CONVERSATION_ID)
            const conversationId = index.conversation
            if (conversationId === undefined) return false
            const after = index.cursors[name] ?? parseEntryId(0)
            let pending: EntryRecord | undefined
            let last = after
            await scan(tx.scanEntries.bind(tx), conversationId, after, (entry) => {
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
          state.retryDelay = initialRetryDelay
          if (!handled) return
        } catch (error) {
          console.error(`Reactor ${name} failed at entry`, attemptedUncommittedEventId, error)
          state.failure = {
            error: String(error),
            at: new Date().toISOString(),
            entryId: attemptedUncommittedEventId,
          }
          if (state.active === active) {
            state.cancelRetry = retryAfter(
              state.retryDelay,
              () => {
                state.cancelRetry = undefined
                drain(name)
              },
              { unref: true },
            )
            state.retryDelay = Math.min(state.retryDelay * 2, 30_000)
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
      }
      if (!reactors.has(name))
        reactors.set(name, {
          kinds: active.kinds,
          chain: Promise.resolve(),
          queued: false,
          retryDelay: initialRetryDelay,
        })
      const state = reactors.get(name)!
      let unsubscribe: (() => void) | undefined
      const stop = () => {
        unsubscribe?.()
        unsubscribe = undefined
        if (state.active === active) {
          state.active = undefined
          state.cancelRetry?.()
          state.cancelRetry = undefined
          state.retryDelay = initialRetryDelay
        }
        return state.chain
      }
      return {
        start: async () => {
          await stop()
          const from = options.from
          if (from && from !== 'start')
            await harness().commit(async (tx) => {
              const index = await tx.doc(EventLog, ROOT_CONVERSATION_ID)
              if (index.cursors[name] !== undefined) return
              const handedOver = from === 'now' ? undefined : index.cursors[from.cursorOf]
              const newest =
                handedOver !== undefined || index.conversation === undefined
                  ? undefined
                  : (await tx.scanEntries({ conversationId: index.conversation }, 1)).items[0]
              index.cursors[name] = handedOver ?? newest?.id ?? parseEntryId(0)
            }, context)
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
    const { index, scanEntries } = readStatus()
    const current = await index()
    const list: ReactorStatus[] = []
    for (const [name, state] of reactors) {
      const cursor = current?.cursors[name] ?? parseEntryId(0)
      let lag = 0
      if (current?.conversation !== undefined)
        await scan(scanEntries, current.conversation, cursor, (entry) => {
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
  }
}
