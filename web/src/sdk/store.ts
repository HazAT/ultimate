import { applyImmutable } from '@earendil-works/chord/delta'
import type { JsonValue } from '@earendil-works/chord/json'
import type { JsonObject, TaskGraph } from '@earendil-works/pi-durable'
import type {
  ConversationSummary,
  ModelsResponse,
  Notice,
  ServerEvents,
  StreamedView,
  SystemInfo,
} from '../../../shared/protocol.ts'

export interface Connection {
  /** `connecting` before the first open, `reconnecting` after a drop. */
  status: 'connecting' | 'open' | 'reconnecting'
  /** Epoch ms of the last status change. */
  since: number
}
/** Per-tab UI state; what should survive a reload lives in `uiState` (ui-state.ts). */
export interface UiState {
  paletteOpen: boolean
  dialogs: Readonly<Record<string, boolean | undefined>>
  theme: 'dark' | 'light'
  /** The surface on screen, which the host records as it renders: the shown one, or the next in line after it failed. */
  surface?: { id: string; title: string }
  /**
   * Whether the sidebar and the panel are open below desktop width, where they are this tab's own (viewport.ts), per
   * viewport: folding a phone shows the conversation, unfolding it brings back what docked beside it.
   */
  open?: Partial<Record<'phone' | 'tablet', { sidebar?: boolean; panels?: boolean }>>
}
type Docs = Readonly<Record<string, JsonObject | null>>
export interface State {
  connection: Connection
  /** The conversation the stream should show; the server's root when absent. */
  requested?: number
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

/** The subset of `EventSource` the store uses, so tests can pass a fake. */
export interface EventSourceLike {
  readonly readyState: number
  addEventListener(name: string, listener: (event: Event) => void): void
  close(): void
}
export interface StoreOptions {
  eventSource?: (url: string) => EventSourceLike
  fetch?: typeof fetch
  /** Delay before reopening a stream the server closed, or a subscription it refused. */
  retryMs?: number
  /** Called when the requested conversation could not be opened and the stream fell back to the root. */
  onFallback?: () => void
  ui?: Partial<UiState>
}

const CLOSED = 2
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
  'notice',
] as const satisfies readonly (keyof ServerEvents)[]
/** Events of one subscription, which carry its id on their first data line. */
const subscribed = new Set<keyof ServerEvents>(['view', 'ops', 'doc', 'docOps'])
type Handler = (name: 'view' | 'ops' | 'doc' | 'docOps', raw: string) => void

/** A scoped view and/or documents of one conversation: its sorted, comma-joined kinds and its subscription. */
interface DocStream {
  kinds: string
  view: boolean
  sub: number
  retry?: ReturnType<typeof setTimeout>
}

/**
 * `docs` after a `doc` snapshot or `docOps` batch. Ops need their subscription's snapshot: a kind without one, such as a
 * kind watched again, waits for the new subscription that brings it.
 */
function applyDoc(docs: Docs, event: ServerEvents['doc'] | ServerEvents['docOps']): Docs {
  if ('value' in event) return { ...docs, [event.kind]: event.value }
  const current = docs[event.kind]
  if (current === undefined) return docs
  return { ...docs, [event.kind]: applyImmutable(current ?? {}, event.ops) }
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
  /** Watch counts of documents of given conversations, by conversation id, then kind. */
  const watchedOf = new Map<number, Map<string, number>>()
  const watchedViews = new Map<number, number>()
  /** One subscription per retained conversation, carrying its view and all its watched kinds. */
  const docStreams = new Map<number, DocStream>()
  /**
   * The tab's one stream carries every subscription: the shown conversation's (`main`) and one per retained
   * conversation. Browsers allow a handful of connections per host, so each further stream would block other requests.
   */
  let source: EventSourceLike | undefined
  /** The open stream's id, which subscriptions are made on; absent until it arrives and after a drop. */
  let streamId: string | undefined
  const handlers = new Map<number, Handler>()
  let nextSub = 0
  let main: number | undefined
  let opened = false
  let retry: ReturnType<typeof setTimeout> | undefined
  let resubscribe: ReturnType<typeof setTimeout> | undefined
  let sync: ReturnType<typeof setTimeout> | undefined
  let noticeId = 0
  let stopped = true
  /**
   * The last `keep` views shown in this tab, by conversation, with the snapshot text each came from: showing one again
   * paints it at once while its stream refreshes it, and a refresh that sends the same snapshot changes nothing.
   */
  const recent = new Map<number, { view: StreamedView; raw?: string }>()
  const keep = 6
  /**
   * The last text of each whole-state event. Every (re)connect resends them, mostly unchanged: skipping an identical one
   * spares the parse and a re-render of everything that reads it (the conversation list is megabytes in a long history).
   */
  const lastRaw: Partial<Record<keyof ServerEvents, string>> = {}
  const snapshots = new Set<keyof ServerEvents>(['system', 'conversations', 'tasks'])
  function remember(view: StreamedView, raw?: string) {
    const id = view.conversation.id
    recent.delete(id)
    recent.set(id, { view, raw })
    if (recent.size > keep) recent.delete(recent.keys().next().value!)
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
      case 'system': {
        const system = data as SystemInfo
        const restarted =
          state.system &&
          (state.system.process.pid !== system.process.pid ||
            state.system.process.generation !== system.process.generation)
        set({ system })
        // oxlint-disable-next-line typescript/no-floating-promises -- refreshModels catches fetch failures and retries on the next system event.
        if (!state.models || restarted) void refreshModels()
        break
      }
      case 'conversations': {
        // The server resends the whole list when one row changes: unchanged rows keep their object, so readers of one
        // row (`useConversationSummary`) skip the re-render.
        const previous = new Map(state.conversations.map((summary) => [summary.id, summary]))
        const conversations = (data as ServerEvents['conversations']).map((summary) => {
          const kept = previous.get(summary.id)
          return kept && JSON.stringify(kept) === JSON.stringify(summary) ? kept : summary
        })
        set({ conversations })
        break
      }
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
        const event = data as ServerEvents['doc'] | ServerEvents['docOps']
        if (!docKinds.has(event.kind)) break
        const docs = applyDoc(state.docs, event)
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

  /** A (re)connect starts from a fresh snapshot; ops of the old stream are gone with it. */
  function receiveView(raw: string) {
    const kept = state.requested === undefined ? undefined : recent.get(state.requested)
    if (kept && kept.raw === raw && state.view === kept.view) {
      if (state.restored) set({ restored: false })
      return
    }
    const view = JSON.parse(raw) as StreamedView
    remember(view, raw)
    set({ view, restored: false })
  }

  /**
   * Subscribe to a conversation on the open stream; `failed` gets the status of a refusal (0 for a network error) while
   * the subscription is current. Without a stream yet, its `stream` event reopens every subscription instead.
   */
  function subscribe(
    spec: { conversation?: number; docs: string[]; view: boolean },
    handler: Handler,
    failed: (status: number) => void,
  ) {
    const sub = ++nextSub
    handlers.set(sub, handler)
    const stream = streamId
    if (stream === undefined) return sub
    const refused = (status: number) => {
      if (handlers.has(sub) && streamId === stream) failed(status)
    }
    void request(`/api/events/${stream}/${sub}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(spec),
    }).then(
      (response) => {
        if (!response.ok) refused(response.status)
      },
      () => refused(0),
    )
    return sub
  }
  function unsubscribe(sub: number | undefined) {
    if (sub === undefined || !handlers.delete(sub) || streamId === undefined) return
    request(`/api/events/${streamId}/${sub}`, { method: 'DELETE' }).catch(() => {
      // The stream is gone, and its subscriptions with it.
    })
  }
  /** (Re)subscribe the shown conversation with the watched kinds, replacing its previous subscription. */
  function openMain() {
    clearTimeout(resubscribe)
    unsubscribe(main)
    const requested = state.requested
    main = subscribe(
      { conversation: requested, docs: [...docKinds.keys()].toSorted(), view: true },
      (name, raw) => (name === 'view' ? receiveView(raw) : handle(name, JSON.parse(raw))),
      (status) => {
        // The stream ended: its reconnect resubscribes.
        if (status === 410) return
        // A conversation that never opened is likely gone (a new home): fall back to the root.
        if (status === 404 && requested !== undefined && !state.view) {
          set({ requested: undefined })
          options.onFallback?.()
          openMain()
        } else resubscribe = setTimeout(openMain, options.retryMs ?? 1000)
      },
    )
  }

  function connect() {
    clearTimeout(retry)
    source?.close()
    streamId = undefined
    const current = open('/api/events')
    source = current
    opened = false
    current.addEventListener('open', () => {
      if (source !== current) return
      opened = true
      setConnection('open')
    })
    current.addEventListener('error', () => {
      if (source !== current) return
      streamId = undefined
      setConnection(opened || state.view ? 'reconnecting' : 'connecting')
      // EventSource retries by itself unless the server answered with an error status.
      if (current.readyState === CLOSED) retry = setTimeout(connect, options.retryMs ?? 1000)
    })
    for (const name of names)
      current.addEventListener(name, (event) => {
        if (source !== current) return
        const raw = (event as MessageEvent<string>).data
        if (subscribed.has(name)) {
          const cut = raw.indexOf('\n')
          handlers.get(Number(raw.slice(0, cut)))?.(
            name as Parameters<Handler>[0],
            raw.slice(cut + 1),
          )
        } else if (name === 'stream') {
          // A new stream, first or after a drop, has no subscriptions: each starts again from a snapshot.
          streamId = (JSON.parse(raw) as ServerEvents['stream']).id
          handlers.clear()
          openMain()
          // A copy: reopening one moves it to the end of the map.
          for (const [conversation, stream] of Array.from(docStreams))
            openDocs(conversation, stream.kinds, stream.view)
        } else if (snapshots.has(name)) {
          if (lastRaw[name] !== raw) {
            lastRaw[name] = raw
            handle(name, JSON.parse(raw))
          } else if (name === 'system' && !state.models)
            // The same system info still retries models a failed fetch left missing.
            // oxlint-disable-next-line typescript/no-floating-promises -- refreshModels catches fetch failures and retries on the next system event.
            void refreshModels()
        } else handle(name, JSON.parse(raw))
      })
  }
  function scheduleMain() {
    if (stopped) return
    clearTimeout(resubscribe)
    resubscribe = setTimeout(openMain, 0)
  }

  function openDocs(conversation: number, kinds: string, withView: boolean) {
    closeDocs(conversation)
    const stream: DocStream = { kinds, view: withView, sub: 0 }
    docStreams.set(conversation, stream)
    stream.sub = subscribe(
      { conversation, docs: kinds ? kinds.split(',') : [], view: withView },
      (name, raw) => {
        const data = JSON.parse(raw)
        if (name === 'view' || name === 'ops') {
          if (!watchedViews.has(conversation)) return
          const current = state.viewsOf[conversation]
          const view =
            name === 'view'
              ? (data as StreamedView)
              : current && applyImmutable(current, data as ServerEvents['ops'])
          if (view) set({ viewsOf: { ...state.viewsOf, [conversation]: view } })
          return
        }
        const change = data as ServerEvents['doc'] | ServerEvents['docOps']
        if (!watchedOf.get(conversation)?.has(change.kind)) return
        const docs = state.docsOf[conversation] ?? {}
        const next = applyDoc(docs, change)
        if (next !== docs) set({ docsOf: { ...state.docsOf, [conversation]: next } })
      },
      (status) => {
        // The stream ended: its reconnect resubscribes.
        if (status !== 410)
          stream.retry = setTimeout(
            () => openDocs(conversation, kinds, withView),
            options.retryMs ?? 1000,
          )
      },
    )
  }
  function closeDocs(conversation: number) {
    const stream = docStreams.get(conversation)
    unsubscribe(stream?.sub)
    clearTimeout(stream?.retry)
    docStreams.delete(conversation)
  }
  /** Scoped views and explicit document watches share one subscription per conversation. */
  function syncDocs() {
    const conversations = new Set([...watchedOf.keys(), ...watchedViews.keys()])
    for (const conversation of docStreams.keys())
      if (!conversations.has(conversation)) closeDocs(conversation)
    const docsOf: Record<number, Docs> = {}
    for (const conversation of conversations) {
      const kinds = watchedOf.get(conversation) ?? new Map<string, number>()
      const list = [...kinds.keys()].toSorted().join(',')
      const stream = docStreams.get(conversation)
      const view = watchedViews.has(conversation)
      // A view watched again needs a fresh snapshot, so adding or dropping it resubscribes.
      if (stream?.kinds !== list || stream.view !== view) openDocs(conversation, list, view)
      // Kinds nobody watches anymore go; the rest keep their value until the new subscription's snapshot replaces it.
      // Unchanged documents stay the same object, so watching another conversation re-renders none of their readers.
      const current = state.docsOf[conversation] ?? {}
      docsOf[conversation] = Object.keys(current).every((kind) => kinds.has(kind))
        ? current
        : Object.fromEntries(Object.entries(current).filter(([kind]) => kinds.has(kind)))
    }
    const viewsOf = Object.fromEntries(
      Object.entries(state.viewsOf).filter(([id]) => watchedViews.has(Number(id))),
    )
    set({ docsOf, viewsOf })
  }
  function scheduleSync() {
    if (stopped) return
    clearTimeout(sync)
    sync = setTimeout(syncDocs, 0)
  }

  async function refreshModels() {
    try {
      const response = await request('/api/models')
      if (response.ok) set({ models: (await response.json()) as ModelsResponse })
    } catch {
      // The next system event retries.
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
      syncDocs()
    },
    stop() {
      stopped = true
      clearTimeout(retry)
      clearTimeout(resubscribe)
      clearTimeout(sync)
      // Closing the stream closes its subscriptions.
      streamId = undefined
      for (const conversation of docStreams.keys()) closeDocs(conversation)
      unsubscribe(main)
      main = undefined
      source?.close()
      source = undefined
    },
    /** Show another conversation: its replica replaces the current one, from the start when it was shown before. */
    show(id: number | undefined) {
      if (id === state.requested) return
      const kept = id === undefined ? undefined : recent.get(id)?.view
      set({
        requested: id,
        view: kept,
        restored: kept !== undefined,
        docs: {},
      })
      scheduleMain()
    },
    /** Retain a live replica without changing the shown conversation. Multiple scopes share one stream. */
    watchConversation(id: number) {
      watchedViews.set(id, (watchedViews.get(id) ?? 0) + 1)
      scheduleSync()
      return () => {
        const left = (watchedViews.get(id) ?? 1) - 1
        if (left > 0) watchedViews.set(id, left)
        else watchedViews.delete(id)
        scheduleSync()
      }
    },
    /** Stream an extension document of the shown conversation until the returned release runs. */
    watchDoc(kind: string) {
      const count = docKinds.get(kind) ?? 0
      docKinds.set(kind, count + 1)
      if (count === 0) scheduleMain()
      return () => {
        const left = (docKinds.get(kind) ?? 1) - 1
        if (left > 0) docKinds.set(kind, left)
        else {
          docKinds.delete(kind)
          const { [kind]: _removed, ...docs } = state.docs
          set({ docs })
        }
      }
    },
    /**
     * Stream an extension document of conversation `conversation`, shown or not, until the returned release runs.
     * Watches of one conversation share a stream.
     */
    watchDocOf(conversation: number, kind: string) {
      const kinds = watchedOf.get(conversation) ?? new Map<string, number>()
      watchedOf.set(conversation, kinds)
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1)
      scheduleSync()
      return () => {
        const left = (kinds.get(kind) ?? 1) - 1
        if (left > 0) kinds.set(kind, left)
        else kinds.delete(kind)
        if (!kinds.size) watchedOf.delete(conversation)
        scheduleSync()
      }
    },
    refreshModels,
    setUi(change: Partial<UiState>) {
      set({ ui: { ...state.ui, ...change } })
    },
    /** Add a notice from the browser, such as a failed command. */
    notify(notice: Notice) {
      handle('notice', notice)
    },
    dismissNotice(id: number) {
      set({ notices: state.notices.filter((notice) => notice.id !== id) })
    },
  }
}
export type Store = ReturnType<typeof createStore>
