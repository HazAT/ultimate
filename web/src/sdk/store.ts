import { parseConversationId } from '../../../lib/ids.shared.ts'
import type { JsonObject, TaskGraph, ConversationId } from '@earendil-works/pi-durable'
import { applyImmutable } from '@earendil-works/chord/delta'
import { deadline, nextTurn, retryAfter } from '../../../lib/timers.shared.ts'
import { keepLast } from '../../../lib/errors.shared.ts'
import type { Cancel } from '../../../lib/timers.shared.ts'
import type { JsonValue } from '@earendil-works/chord/json'
import { MAX_SUBSCRIPTION_BATCH_BYTES } from '../../../shared/protocol.ts'
import type {
  ConversationSummary,
  ModelsResponse,
  Notice,
  ReadPayload,
  ReadSpec,
  ServerEvents,
  StreamedView,
  SubscriptionsAnswer,
  SubscriptionsRequest,
  SystemInfo,
} from '../../../shared/protocol.ts'

export interface Connection {
  /** `connecting` before the first open, `reconnecting` after a drop. */
  status: 'connecting' | 'open' | 'reconnecting'
  /** Epoch ms of the last status change. */
  since: number
}

export interface UiState {
  paletteOpen: boolean
  dialogs: Readonly<Record<string, boolean | undefined>>
  theme: 'dark' | 'light'
  surface?: { id: string; title: string }
  open?: Partial<Record<'phone' | 'tablet', { sidebar?: boolean; panels?: boolean }>>
}
type Docs = Readonly<Record<string, JsonObject | null>>
export interface State {
  connection: Connection
  /** The conversation the stream should show; the server's root when absent. */
  requested?: ConversationId
  /** The shown conversation's replica: snapshot plus every applied ops batch. */
  view?: StreamedView
  /** `view` is what this tab showed of the requested conversation before; its stream's snapshot replaces it. */
  restored?: boolean
  /** Replicas retained by `ConversationScope`, independent of the shown conversation. */
  viewsOf: Readonly<Record<number, StreamedView | undefined>>
  /** Extension documents of the shown conversation, by kind. */
  docs: Docs
  /** Extension documents of given conversations (`watchDocOf`), by conversation id, then kind. */
  docsOf: Readonly<Record<number, Docs>>
  /** The root conversation's `ultimate.ui` document, once streamed; read it through `uiState`. */
  shared?: Readonly<Record<string, JsonValue>>
  system?: SystemInfo
  conversations: readonly ConversationSummary[]
  tasks?: TaskGraph
  models?: ModelsResponse
  notices: readonly (Notice & { id: number; at: number })[]
  ui: UiState
}

export interface EventSourceLike {
  readonly readyState: number
  addEventListener(name: string, listener: (event: Event) => void): void
  close: () => void
}
export interface StoreOptions {
  eventSource?: (url: string) => EventSourceLike
  fetch?: typeof fetch
  retryMs?: number
  flushTimeoutMs?: number
  onFallback?: () => void
  ui?: Partial<UiState>
}

const ROOT = parseConversationId(1)
const EVENT_SOURCE_CLOSED_NO_RETRY = 2
const STREAM_GONE_RECONNECT_RESUBSCRIBES = 410
const utf8Bytes = new TextEncoder()
const jsonBytes = (value: unknown) => utf8Bytes.encode(JSON.stringify(value)).byteLength
const EMPTY_BATCH_BYTES = jsonBytes({ subscribe: [], unsubscribe: [] })
const names = [
  'stream',
  'system',
  'conversations',
  'view',
  'ops',
  'ui',
  'uiOps',
  'doc',
  'docOps',
  'tasks',
  'conversationsOps',
  'tasksOps',
  'notice',
  'read',
] as const satisfies readonly (keyof ServerEvents)[]

const subscriptionIdPrefixedEvents = new Set<keyof ServerEvents>([
  'view',
  'ops',
  'doc',
  'docOps',
  'read',
])
type Handler = (name: 'view' | 'ops' | 'doc' | 'docOps' | 'read', raw: string) => void
type Spec =
  | { conversation?: ConversationId; docs: string[]; view: boolean }
  | { read: ReadSpec; every?: number }
type Refused = (status: number) => void

type DocChange = ServerEvents['doc'] | ServerEvents['docOps']
type ReadNotice = ReadPayload & { rev?: number }
interface ReadWatch {
  read: ReadSpec
  every?: number
  onEvent: (event: ReadNotice) => void
  refused?: boolean
}
interface DocWatch {
  count: number
  refused?: Set<ConversationId>
}
interface Wanted {
  spec: Spec
  handler: Handler
  readWatch?: ReadWatch
  docWatch?: { watch: DocWatch; target: ConversationId }
}

function applyDoc(docs: Docs, event: DocChange): Docs {
  if ('value' in event) return { ...docs, [event.kind]: event.value }
  const subscriptionSnapshot = docs[event.kind]
  if (subscriptionSnapshot === undefined) return docs
  return { ...docs, [event.kind]: applyImmutable(subscriptionSnapshot ?? {}, event.ops) }
}

export function createStore(options: StoreOptions = {}) {
  const open = options.eventSource ?? ((url: string) => new EventSource(url))
  const request = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  let state: State = {
    connection: { status: 'connecting', since: Date.now() },
    viewsOf: {},
    docs: {},
    docsOf: {},
    conversations: [],
    notices: [],
    ui: {
      paletteOpen: false,
      dialogs: {},
      theme: 'dark',
      ...options.ui,
    },
  }
  const listeners = new Set<() => void>()
  const docKinds = new Map<string, DocWatch>()

  const docWatchCountsByConversation = new Map<ConversationId, Map<string, DocWatch>>()
  const watchedViews = new Map<ConversationId, number>()
  const watchedReads = new Map<string, ReadWatch>()

  let multiplexedEventSource: EventSourceLike | undefined

  let streamId: string | undefined
  const handlers = new Map<number, Handler>()
  let nextSub = 0
  const live = new Map<string, { sub: number; readWatch?: ReadWatch }>()
  const opening = new Map<number, { spec: Spec; failed: Refused }>()
  const closing = new Set<number>()
  let opened = false
  let cancelRetry: Cancel | undefined
  let cancelReconcile: Cancel | undefined
  let cancelResubscribe: Cancel | undefined
  let cancelFlushTimeout: Cancel | undefined
  let activeFlush: AbortController | undefined
  let flushQueued = false
  let flushing = false
  let maxBatchSize = Infinity
  let noticeId = 0
  let stopped = true

  const recentViewsWithRawSnapshots = new Map<
    ConversationId,
    { view: StreamedView; raw?: string }
  >()
  const retainedConversationLimit = 6

  let lastSystemText: string | undefined
  function remember(view: StreamedView, raw?: string) {
    const id = view.conversation.id
    recentViewsWithRawSnapshots.delete(id)
    recentViewsWithRawSnapshots.set(id, { view, raw })
    if (recentViewsWithRawSnapshots.size > retainedConversationLimit)
      recentViewsWithRawSnapshots.delete(recentViewsWithRawSnapshots.keys().next().value!)
  }

  function set(change: Partial<State>) {
    state = { ...state, ...change }
    for (const listener of listeners) listener()
  }
  function setConnection(status: Connection['status']) {
    if (state.connection.status !== status) set({ connection: { status, since: Date.now() } })
  }

  function handle(name: keyof ServerEvents, data: unknown) {
    switch (name) {
      case 'stream':
      case 'view':
      case 'read':
        break
      case 'system': {
        const system = data as SystemInfo
        const restarted =
          state.system &&
          (state.system.process.pid !== system.process.pid ||
            state.system.process.generation !== system.process.generation)
        set({ system })
        if (!state.models || restarted) void refreshModels()
        break
      }
      case 'conversations': {
        const previous = new Map(state.conversations.map((summary) => [summary.id, summary]))
        const conversations = (data as ServerEvents['conversations']).map((summary) => {
          const kept = previous.get(summary.id)
          const unchangedRowKeepsIdentity = kept && JSON.stringify(kept) === JSON.stringify(summary)
          return unchangedRowKeepsIdentity ? kept : summary
        })
        const unchanged =
          conversations.length === state.conversations.length &&
          conversations.every((summary, index) => summary === state.conversations[index])
        if (!unchanged) set({ conversations })
        break
      }
      case 'conversationsOps':
        set({
          conversations: applyImmutable(
            state.conversations,
            data as ServerEvents['conversationsOps'],
          ),
        })
        break
      case 'tasksOps':
        if (state.tasks)
          set({ tasks: applyImmutable(state.tasks, data as ServerEvents['tasksOps']) })
        break
      case 'ops':
        if (state.view) {
          const view = applyImmutable(state.view, data as ServerEvents['ops'])
          remember(view)
          set({ view })
        }
        break
      case 'ui':
        set({ shared: (data as ServerEvents['ui']).value })
        break
      case 'uiOps':
        if (state.shared)
          set({
            shared: applyImmutable(state.shared, (data as ServerEvents['uiOps']).ops),
          })
        break
      case 'doc':
      case 'docOps': {
        const docs = applyDoc(state.docs, data as DocChange)
        if (docs !== state.docs) set({ docs })
        break
      }
      case 'tasks':
        set({ tasks: data as TaskGraph })
        break
      case 'notice':
        set({
          notices: [
            ...state.notices.slice(-49),
            { ...(data as Notice), id: ++noticeId, at: Date.now() },
          ],
        })
        break
    }
  }

  function replaceViewFromFreshSnapshot(raw: string) {
    const kept =
      state.requested === undefined ? undefined : recentViewsWithRawSnapshots.get(state.requested)
    if (kept && kept.raw === raw && state.view === kept.view) {
      if (state.restored) set({ restored: false })
      return
    }
    const view = JSON.parse(raw) as StreamedView
    remember(view, raw)
    set({ view, restored: false })
  }

  function subscribe(spec: Spec, handler: Handler, failed: Refused) {
    const sub = ++nextSub
    handlers.set(sub, handler)
    if (streamId === undefined) return sub
    opening.set(sub, { spec, failed })
    scheduleFlush()
    return sub
  }
  function retire(sub: number) {
    if (!handlers.delete(sub) || streamId === undefined) return
    if (opening.delete(sub)) return
    closing.add(sub)
  }
  function scheduleFlush() {
    if (flushQueued) return
    flushQueued = true
    queueMicrotask(flush)
  }
  function abortActiveFlush() {
    cancelFlushTimeout?.()
    cancelFlushTimeout = undefined
    activeFlush?.abort()
    activeFlush = undefined
  }
  function reconnectAfterRetry() {
    cancelRetry?.()
    abortActiveFlush()
    multiplexedEventSource?.close()
    multiplexedEventSource = undefined
    streamId = undefined
    flushing = false
    flushQueued = false
    handlers.clear()
    opening.clear()
    closing.clear()
    live.clear()
    if (state.connection.status === 'open') setConnection('reconnecting')
    cancelRetry = retryAfter(options.retryMs ?? 1000, connect)
  }
  function takeBatch() {
    const opens = new Map<number, { spec: Spec; failed: Refused }>()
    const closes: number[] = []
    const locallyRefused: [number, Refused][] = []
    let remaining = maxBatchSize
    let bytes = EMPTY_BATCH_BYTES
    for (const [sub, entry] of opening) {
      if (remaining <= 0) break
      const itemBytes = jsonBytes({ sub, ...entry.spec })
      if (EMPTY_BATCH_BYTES + itemBytes > MAX_SUBSCRIPTION_BATCH_BYTES) {
        opening.delete(sub)
        locallyRefused.push([sub, entry.failed])
        continue
      }
      const nextBytes = bytes + itemBytes + (opens.size > 0 ? 1 : 0)
      if (opens.size > 0 && nextBytes > MAX_SUBSCRIPTION_BATCH_BYTES) break
      opens.set(sub, entry)
      opening.delete(sub)
      bytes = nextBytes
      remaining--
    }
    for (const sub of closing) {
      if (remaining <= 0) break
      const itemBytes = String(sub).length
      const nextBytes = bytes + itemBytes + (closes.length > 0 ? 1 : 0)
      if ((opens.size > 0 || closes.length > 0) && nextBytes > MAX_SUBSCRIPTION_BATCH_BYTES) break
      closes.push(sub)
      closing.delete(sub)
      bytes = nextBytes
      remaining--
    }
    return { opens, closes, locallyRefused }
  }
  function deliverRefusals(refusals: [number, number, Refused | undefined][]) {
    let firstError: unknown
    let failed = false
    for (const [sub, status, refuse] of refusals) {
      handlers.delete(sub)
      closing.delete(sub)
      if (!refuse) continue
      try {
        refuse(status)
      } catch (error) {
        if (!failed) {
          failed = true
          firstError = error
        }
      }
    }
    if (failed) throw firstError
  }
  function flush() {
    if (!flushQueued || flushing) return
    flushQueued = false
    const stream = streamId
    if (stream === undefined || (!opening.size && !closing.size)) return
    const { opens, closes, locallyRefused } = takeBatch()
    const localRefusals: [number, number, Refused | undefined][] = locallyRefused.map(
      ([sub, refuse]) => [sub, 413, refuse],
    )
    if (!opens.size && !closes.length) {
      if (opening.size || closing.size) scheduleFlush()
      deliverRefusals(localRefusals)
      return
    }
    flushing = true
    const batchSize = opens.size + closes.length
    const batch: SubscriptionsRequest = {
      subscribe: [...opens].map(([sub, { spec }]) => ({ sub, ...spec })),
      unsubscribe: closes,
    }
    const controller = new AbortController()
    activeFlush = controller
    const cancelTimeout = deadline(options.flushTimeoutMs ?? 15_000, () => {
      if (activeFlush !== controller || streamId !== stream) return
      reconnectAfterRetry()
    })
    cancelFlushTimeout = cancelTimeout
    void request(`/api/events/${stream}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batch),
      signal: controller.signal,
    })
      .then(async (response) => {
        if (response.status === STREAM_GONE_RECONNECT_RESUBSCRIBES) return 'gone' as const
        if (response.status === 413) {
          const singleOpen = opens.size === 1 && closes.length === 0
          if (singleOpen) {
            const [[sub, { spec }]] = opens
            if ('read' in spec || !spec.view) return { refused: { [sub]: 413 } }
          }
          if (batchSize > 1) maxBatchSize = Math.max(1, Math.floor(batchSize / 2))
          return 'ambiguous' as const
        }
        if (response.status !== 200) return 'ambiguous' as const
        const answer = (await response.json()) as Partial<SubscriptionsAnswer>
        return answeredFor(opens, answer) ? { refused: answer.refused } : ('ambiguous' as const)
      })
      .catch(() => 'ambiguous' as const)
      .then((result) => {
        if (activeFlush !== controller || streamId !== stream) return
        if (result === 'gone') return connect()
        if (result === 'ambiguous') return reconnectAfterRetry()
        deliverRefusals(
          Object.entries(result.refused).map(([id, status]) => {
            const sub = Number(id)
            return [sub, status, opens.get(sub)?.failed]
          }),
        )
        if (!opening.size && !closing.size) maxBatchSize = Infinity
      })
      .finally(() => {
        if (activeFlush !== controller) return
        cancelTimeout()
        cancelFlushTimeout = undefined
        activeFlush = undefined
        if (streamId !== stream) return
        flushing = false
        flushQueued = false
        if (opening.size || closing.size) scheduleFlush()
      })
    deliverRefusals(localRefusals)
  }

  function answeredFor(
    opens: ReadonlyMap<number, unknown>,
    answer: Partial<SubscriptionsAnswer>,
  ): answer is SubscriptionsAnswer {
    const { ok, refused } = answer
    return (
      ok === true &&
      typeof refused === 'object' &&
      refused !== null &&
      !Array.isArray(refused) &&
      Object.entries(refused).every(
        ([sub, status]) =>
          opens.has(Number(sub)) &&
          String(Number(sub)) === sub &&
          Number.isInteger(status) &&
          status >= 400 &&
          status < 600 &&
          status !== STREAM_GONE_RECONNECT_RESUBSCRIBES,
      )
    )
  }

  const shownKey = () => `shown:${state.requested ?? 'root'}`
  function docSubscription(
    conversation: ConversationId | undefined,
    kind: string,
    apply: (change: DocChange) => void,
  ): Wanted {
    return {
      spec: { conversation, docs: [kind], view: false },
      handler: (_name, raw) => {
        const change = JSON.parse(raw) as DocChange
        if (change.kind === kind) apply(change)
      },
    }
  }
  function wanted() {
    const result = new Map<string, Wanted>()
    const shown = shownKey()
    result.set(`${shown}:view`, {
      spec: { conversation: state.requested, docs: [], view: true },
      handler: (name, raw) =>
        name === 'view' ? replaceViewFromFreshSnapshot(raw) : handle(name, JSON.parse(raw)),
    })
    const shownTarget = state.requested ?? ROOT
    for (const [kind, watch] of docKinds) {
      if (watch.refused?.has(shownTarget)) continue
      result.set(`${shown}:doc:${kind}`, {
        ...docSubscription(state.requested, kind, (change) => handle('doc', change)),
        docWatch: { watch, target: shownTarget },
      })
    }
    for (const conversation of watchedViews.keys())
      result.set(`${conversation}:view`, {
        spec: { conversation, docs: [], view: true },
        handler: (name, raw) => {
          const data = JSON.parse(raw)
          const current = state.viewsOf[conversation]
          const view =
            name === 'view'
              ? (data as StreamedView)
              : current && applyImmutable(current, data as ServerEvents['ops'])
          if (view) set({ viewsOf: { ...state.viewsOf, [conversation]: view } })
        },
      })
    for (const [conversation, kinds] of docWatchCountsByConversation)
      for (const [kind, watch] of kinds) {
        if (watch.refused?.has(conversation)) continue
        result.set(`${conversation}:doc:${kind}`, {
          ...docSubscription(conversation, kind, (change) => {
            const docs = state.docsOf[conversation] ?? {}
            const next = applyDoc(docs, change)
            if (next !== docs) set({ docsOf: { ...state.docsOf, [conversation]: next } })
          }),
          docWatch: { watch, target: conversation },
        })
      }
    for (const [key, readWatch] of watchedReads) {
      if (readWatch.refused) continue
      const { read, every } = readWatch
      result.set(`read:${key}`, {
        spec: every === undefined ? { read } : { read, every },
        readWatch,
        handler: (name, raw) => {
          if (name !== 'read' || watchedReads.get(key) !== readWatch) return
          const parsed = JSON.parse(raw) as ReadNotice
          readWatch.onEvent(
            parsed.rev === undefined || Number.isSafeInteger(parsed.rev)
              ? parsed
              : { ...parsed, rev: undefined },
          )
        },
      })
    }
    return result
  }

  function refusedOpen(
    key: string,
    sub: number,
    status: number,
    readWatch?: ReadWatch,
    docWatch?: { watch: DocWatch; target: ConversationId },
  ) {
    if (live.get(key)?.sub !== sub) return
    live.delete(key)
    if (docWatch && status === 413) {
      if (docWatch.watch.count > 0) {
        docWatch.watch.refused ??= new Set()
        if (!docWatch.watch.refused.has(docWatch.target)) {
          docWatch.watch.refused.add(docWatch.target)
          handle('notice', {
            level: 'error',
            message: `Subscription too large: ${key.slice(0, 120)}`,
          })
        }
      } else scheduleReconcile()
      return
    }
    if (readWatch && status >= 400 && status < 500) {
      if (watchedReads.get(key.slice(5)) === readWatch) {
        readWatch.refused = true
        readWatch.onEvent({ error: 'The server refused this read', status })
      } else scheduleReconcile()
      return
    }
    const requested = state.requested
    if (status === 404 && requested !== undefined && key === `${shownKey()}:view`) {
      retireShownUntilReconcile()
      recentViewsWithRawSnapshots.delete(requested)
      set({ requested: undefined, view: undefined, restored: false, docs: {} })
      options.onFallback?.()
      reconcile()
    } else
      cancelResubscribe ??= retryAfter(options.retryMs ?? 1000, () => {
        cancelResubscribe = undefined
        reconcile()
      })
  }
  function retireShownUntilReconcile() {
    for (const [key, { sub }] of live)
      if (key.startsWith('shown:')) {
        live.delete(key)
        retire(sub)
      }
  }

  function reconcile() {
    cancelReconcile?.()
    cancelReconcile = undefined
    if (stopped) return
    const want = wanted()
    for (const [key, { sub, readWatch }] of live) {
      const next = want.get(key)
      if (next && next.readWatch === readWatch) continue
      live.delete(key)
      retire(sub)
    }
    if (closing.size) scheduleFlush()
    if (streamId !== undefined)
      for (const [key, { spec, handler, readWatch, docWatch }] of want)
        if (!live.has(key)) {
          const sub: number = subscribe(spec, handler, (status) =>
            refusedOpen(key, sub, status, readWatch, docWatch),
          )
          live.set(key, { sub, readWatch })
        }
    const keep = <T>(record: Readonly<Record<string, T>>, has: (key: string) => boolean) =>
      Object.keys(record).every(has)
        ? record
        : Object.fromEntries(Object.entries(record).filter(([key]) => has(key)))
    const docsOf: Record<number, Docs> = {}
    for (const [conversation, kinds] of docWatchCountsByConversation)
      docsOf[conversation] = keep(state.docsOf[conversation] ?? {}, (kind) => kinds.has(kind))
    const nextDocs = keep(state.docs, (kind) => docKinds.has(kind))
    const nextDocsOf =
      Object.keys(state.docsOf).length === docWatchCountsByConversation.size &&
      Object.entries(docsOf).every(([id, docs]) => docs === state.docsOf[Number(id)])
        ? state.docsOf
        : docsOf
    const nextViewsOf = keep(state.viewsOf, (id) =>
      watchedViews.has(parseConversationId(Number(id))),
    )
    if (nextDocs !== state.docs || nextDocsOf !== state.docsOf || nextViewsOf !== state.viewsOf)
      set({ docs: nextDocs, docsOf: nextDocsOf, viewsOf: nextViewsOf })
  }
  function scheduleReconcile() {
    if (!stopped) cancelReconcile ??= nextTurn(reconcile)
  }

  function connect() {
    cancelRetry?.()
    abortActiveFlush()
    multiplexedEventSource?.close()
    streamId = undefined
    flushing = false
    if (state.connection.status === 'open') setConnection('reconnecting')
    const current = open('/api/events')
    multiplexedEventSource = current
    opened = false
    current.addEventListener('open', () => {
      if (multiplexedEventSource !== current) return
      opened = true
      setConnection('open')
    })
    current.addEventListener('error', () => {
      if (multiplexedEventSource !== current) return
      streamId = undefined
      abortActiveFlush()
      flushing = false
      flushQueued = false
      setConnection(opened || state.view ? 'reconnecting' : 'connecting')

      if (current.readyState === EVENT_SOURCE_CLOSED_NO_RETRY)
        cancelRetry = retryAfter(options.retryMs ?? 1000, connect)
    })
    for (const name of names)
      current.addEventListener(name, (event) => {
        if (multiplexedEventSource !== current) return
        const raw = (event as MessageEvent<string>).data
        if (subscriptionIdPrefixedEvents.has(name)) {
          const cut = raw.indexOf('\n')
          handlers.get(Number(raw.slice(0, cut)))?.(
            name as Parameters<Handler>[0],
            raw.slice(cut + 1),
          )
        } else if (name === 'stream') {
          streamId = (JSON.parse(raw) as ServerEvents['stream']).id
          abortActiveFlush()
          flushing = false
          flushQueued = false
          handlers.clear()
          opening.clear()
          closing.clear()
          live.clear()
          reconcile()
          flush()
        } else if (name === 'system') {
          if (lastSystemText !== raw) {
            lastSystemText = raw
            handle(name, JSON.parse(raw))
          } else if (!state.models) void refreshModels()
        } else handle(name, JSON.parse(raw))
      })
  }

  async function refreshModels() {
    try {
      const response = await request('/api/models')
      if (response.ok) set({ models: (await response.json()) as ModelsResponse })
    } catch (error) {
      keepLast(error)
    }
  }

  return {
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    start() {
      if (!stopped) return
      stopped = false
      connect()
      reconcile()
    },
    stop() {
      stopped = true
      cancelRetry?.()
      cancelReconcile?.()
      cancelReconcile = undefined
      cancelResubscribe?.()
      cancelResubscribe = undefined
      abortActiveFlush()

      streamId = undefined
      flushing = false
      flushQueued = false
      maxBatchSize = Infinity
      handlers.clear()
      opening.clear()
      closing.clear()
      live.clear()
      multiplexedEventSource?.close()
      multiplexedEventSource = undefined
      if (state.connection.status === 'open') setConnection('reconnecting')
    },

    show(id: ConversationId | undefined) {
      if (id === state.requested) return
      retireShownUntilReconcile()
      const kept = id === undefined ? undefined : recentViewsWithRawSnapshots.get(id)?.view
      set({
        requested: id,
        view: kept,
        restored: kept !== undefined,
        docs: {},
      })
      scheduleReconcile()
    },

    watchConversation(id: ConversationId) {
      watchedViews.set(id, (watchedViews.get(id) ?? 0) + 1)
      scheduleReconcile()
      return () => {
        const left = (watchedViews.get(id) ?? 1) - 1
        if (left > 0) watchedViews.set(id, left)
        else watchedViews.delete(id)
        scheduleReconcile()
      }
    },

    watchDoc(kind: string) {
      const watch = docKinds.get(kind) ?? { count: 0 }
      watch.count++
      docKinds.set(kind, watch)
      scheduleReconcile()
      return () => {
        if (--watch.count === 0 && docKinds.get(kind) === watch) docKinds.delete(kind)
        scheduleReconcile()
      }
    },

    watchDocOf(conversation: ConversationId, kind: string) {
      const kinds = docWatchCountsByConversation.get(conversation) ?? new Map<string, DocWatch>()
      docWatchCountsByConversation.set(conversation, kinds)
      const watch = kinds.get(kind) ?? { count: 0 }
      watch.count++
      kinds.set(kind, watch)
      scheduleReconcile()
      return () => {
        if (--watch.count === 0 && kinds.get(kind) === watch) kinds.delete(kind)
        if (!kinds.size) docWatchCountsByConversation.delete(conversation)
        scheduleReconcile()
      }
    },
    watchRead(read: ReadSpec, every: number | undefined, onEvent: (event: ReadNotice) => void) {
      const key = JSON.stringify([read, every ?? null])
      const watch = { read, every, onEvent }
      watchedReads.set(key, watch)
      scheduleReconcile()
      return () => {
        if (watchedReads.get(key) !== watch) return
        watchedReads.delete(key)
        scheduleReconcile()
      }
    },
    refreshModels,
    setUi(change: Partial<UiState>) {
      set({ ui: { ...state.ui, ...change } })
    },

    notify(notice: Notice) {
      handle('notice', notice)
    },
    dismissNotice(id: number) {
      set({ notices: state.notices.filter((notice) => notice.id !== id) })
    },
  }
}
export type Store = ReturnType<typeof createStore>
