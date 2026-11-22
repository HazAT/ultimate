import { parseConversationId } from '../../../lib/ids.ts'
import type { JsonObject, TaskGraph, ConversationId } from '@earendil-works/pi-durable'
import { applyImmutable } from '@earendil-works/chord/delta'
import { nextTurn, retryAfter } from '../../../lib/timers.ts'
import { keepLast } from '../../../lib/errors.ts'
import type { Cancel } from '../../../lib/timers.ts'
import type { JsonValue } from '@earendil-works/chord/json'
import type {
  ConversationSummary,
  ModelsResponse,
  Notice,
  ReadEvent,
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
  onFallback?: () => void
  ui?: Partial<UiState>
}

const EVENT_SOURCE_CLOSED_NO_RETRY = 2
const STREAM_GONE_RECONNECT_RESUBSCRIBES = 410
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
interface Wanted {
  spec: Spec
  handler: Handler
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
  const docKinds = new Map<string, number>()

  const docWatchCountsByConversation = new Map<ConversationId, Map<string, number>>()
  const watchedViews = new Map<ConversationId, number>()
  const watchedReads = new Map<
    string,
    { read: ReadSpec; every?: number; onEvent: (event: ReadEvent) => void }
  >()

  let multiplexedEventSource: EventSourceLike | undefined

  let streamId: string | undefined
  const handlers = new Map<number, Handler>()
  let nextSub = 0
  const live = new Map<string, number>()
  const opening = new Map<number, { spec: Spec; failed: Refused }>()
  const closing = new Set<number>()
  let opened = false
  let cancelRetry: Cancel | undefined
  let cancelReconcile: Cancel | undefined
  let cancelResubscribe: Cancel | undefined
  let cancelCloseRetry: Cancel | undefined
  let flushQueued = false
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
    if (!handlers.delete(sub) || streamId === undefined) return false
    if (opening.delete(sub)) return false
    closing.add(sub)
    return true
  }
  function unsubscribe(sub: number) {
    if (retire(sub)) scheduleFlush()
  }
  function scheduleFlush() {
    if (flushQueued) return
    flushQueued = true
    queueMicrotask(flush)
  }
  function flush() {
    if (!flushQueued) return
    flushQueued = false
    const stream = streamId
    const opens = new Map(opening)
    const closes = [...closing]
    opening.clear()
    closing.clear()
    if (stream === undefined || (!opens.size && !closes.length)) return
    const batch: SubscriptionsRequest = {
      subscribe: [...opens].map(([sub, { spec }]) => ({ sub, ...spec })),
      unsubscribe: closes,
    }
    const unanswered = (status = 0) => ({
      refused: Object.fromEntries(
        [...opens].map(([sub, { spec }]) => [sub, 'read' in spec ? status : 0]),
      ),
      confirmed: false,
    })
    void request(`/api/events/${stream}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batch),
    })
      .then(async (response) => {
        if (response.status === STREAM_GONE_RECONNECT_RESUBSCRIBES) return undefined
        if (!response.ok) return unanswered(response.status)
        const answer = (await response.json()) as Partial<SubscriptionsAnswer>
        return answeredFor(opens, answer)
          ? { refused: answer.refused, confirmed: true }
          : unanswered()
      })
      .catch(() => unanswered())
      .then((result) => {
        if (streamId !== stream || result === undefined) return
        const { refused, confirmed } = result
        if (confirmed) for (const sub of Object.keys(refused)) handlers.delete(Number(sub))
        else if (closes.length) {
          for (const sub of closes) closing.add(sub)
          cancelCloseRetry ??= retryAfter(options.retryMs ?? 1000, () => {
            cancelCloseRetry = undefined
            scheduleFlush()
          })
        }
        for (const [sub, status] of Object.entries(refused)) opens.get(Number(sub))?.failed(status)
      })
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
    for (const kind of docKinds.keys())
      result.set(
        `${shown}:doc:${kind}`,
        docSubscription(state.requested, kind, (change) => handle('doc', change)),
      )
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
      for (const kind of kinds.keys())
        result.set(
          `${conversation}:doc:${kind}`,
          docSubscription(conversation, kind, (change) => {
            const docs = state.docsOf[conversation] ?? {}
            const next = applyDoc(docs, change)
            if (next !== docs) set({ docsOf: { ...state.docsOf, [conversation]: next } })
          }),
        )
    for (const [key, { read, every }] of watchedReads)
      result.set(`read:${key}`, {
        spec: every === undefined ? { read } : { read, every },
        handler: (name, raw) => {
          if (name === 'read') watchedReads.get(key)?.onEvent(JSON.parse(raw) as ReadEvent)
        },
      })
    return result
  }

  function refusedOpen(key: string, sub: number, status: number) {
    if (live.get(key) !== sub) return
    const read = key.startsWith('read:') ? watchedReads.get(key.slice(5)) : undefined
    if (read && status >= 400 && status < 500) {
      read.onEvent({ error: 'The server refused this read', status })
      return
    }
    live.delete(key)
    unsubscribe(sub)
    const requestedConversationNeverOpened =
      key === `${shownKey()}:view` && status === 404 && state.requested !== undefined && !state.view
    if (requestedConversationNeverOpened) {
      retireShownUntilReconcile()
      set({ requested: undefined, docs: {} })
      options.onFallback?.()
      reconcile()
    } else
      cancelResubscribe ??= retryAfter(options.retryMs ?? 1000, () => {
        cancelResubscribe = undefined
        reconcile()
      })
  }
  function retireShownUntilReconcile() {
    for (const [key, sub] of live)
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
    for (const [key, sub] of live)
      if (!want.has(key)) {
        live.delete(key)
        retire(sub)
      }
    if (closing.size) scheduleFlush()
    if (streamId !== undefined)
      for (const [key, { spec, handler }] of want)
        if (!live.has(key)) {
          const sub: number = subscribe(spec, handler, (status) => refusedOpen(key, sub, status))
          live.set(key, sub)
        }
    const keep = <T>(record: Readonly<Record<string, T>>, has: (key: string) => boolean) =>
      Object.keys(record).every(has)
        ? record
        : Object.fromEntries(Object.entries(record).filter(([key]) => has(key)))
    const docsOf: Record<number, Docs> = {}
    for (const [conversation, kinds] of docWatchCountsByConversation)
      docsOf[conversation] = keep(state.docsOf[conversation] ?? {}, (kind) => kinds.has(kind))
    set({
      docs: keep(state.docs, (kind) => docKinds.has(kind)),
      docsOf,
      viewsOf: keep(state.viewsOf, (id) => watchedViews.has(parseConversationId(Number(id)))),
    })
  }
  function scheduleReconcile() {
    if (!stopped) cancelReconcile ??= nextTurn(reconcile)
  }

  function connect() {
    cancelRetry?.()
    multiplexedEventSource?.close()
    streamId = undefined
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
          handlers.clear()
          opening.clear()
          closing.clear()
          cancelCloseRetry?.()
          cancelCloseRetry = undefined
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
      cancelCloseRetry?.()
      cancelCloseRetry = undefined

      streamId = undefined
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
      docKinds.set(kind, (docKinds.get(kind) ?? 0) + 1)
      scheduleReconcile()
      return () => {
        const left = (docKinds.get(kind) ?? 1) - 1
        if (left > 0) docKinds.set(kind, left)
        else docKinds.delete(kind)
        scheduleReconcile()
      }
    },

    watchDocOf(conversation: ConversationId, kind: string) {
      const kinds = docWatchCountsByConversation.get(conversation) ?? new Map<string, number>()
      docWatchCountsByConversation.set(conversation, kinds)
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1)
      scheduleReconcile()
      return () => {
        const left = (kinds.get(kind) ?? 1) - 1
        if (left > 0) kinds.set(kind, left)
        else kinds.delete(kind)
        if (!kinds.size) docWatchCountsByConversation.delete(conversation)
        scheduleReconcile()
      }
    },
    watchRead(read: ReadSpec, every: number | undefined, onEvent: (event: ReadEvent) => void) {
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
