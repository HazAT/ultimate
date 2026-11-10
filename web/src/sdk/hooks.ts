import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type { JsonValue } from '@earendil-works/chord'
import type { ToolCall } from '@earendil-works/pi-ai'
import type {
  AgentState,
  EntryRecord,
  InboxItem,
  JsonObject,
  LiveState,
  UsageState,
} from '@earendil-works/pi-durable'
import { actions, allCommands, ownDefault, regionKeys, shellKeys, shownSurface } from './actions.ts'
import type { Region } from './actions.ts'
import { ROOT } from './api.ts'
import { EVENT_FEED } from '../../../shared/events.ts'
import type { StreamedView } from '../../../shared/protocol.ts'
import type { EventData, EventRecord, EventToken } from '../../../shared/events.ts'
import type { ActionArgs, ActionError } from './api.ts'
import { docRef } from '../../../shared/extension-api.ts'
import type { ActionRef, DocRef } from '../../../shared/extension-api.ts'
import { api, reads, registry, store, uiState } from './client.ts'
import type { Reader } from './reads.ts'
import {
  HOME,
  compactDocs,
  compactTools,
  documentItems,
  panelItems,
  shownPanels,
} from './registry.ts'
import type { State } from './store.ts'
import { errorMessage, formatDuration } from './format.ts'
import { translator } from './i18n.ts'
import type { Translate } from './i18n.ts'
import type { CompactRow, ToolCallView, UltimateContext } from './types.ts'
import { useViewport } from './viewport.ts'
import { ConversationIdContext, TranscriptContext } from './conversation-scope.tsx'
export { TranscriptContext } from './conversation-scope.tsx'

/** Page readiness is sticky; failed facet names remain available even before ready. */
export function useReady(): {
  ready: boolean
  timedOut: boolean
  failed: string[]
  pending: string[]
} {
  return useSyncExternalStore(registry.subscribe, registry.getReady)
}

/** Read a slice of the client state; re-renders when the selected value changes identity. */
export function useStore<T>(select: (state: State) => T): T {
  return useSyncExternalStore(store.subscribe, () => select(store.getState()))
}

export interface ConversationState {
  /** The scoped (or shown) conversation, once its snapshot arrived. */
  id?: number
  /** True until this conversation's snapshot arrived. */
  loading: boolean
  /**
   * The streamed entries, oldest first: the newest of a long transcript, all of a short one, head markers in place.
   * Whole-transcript readers use `useTranscript()`, which grows as the reader pages in earlier history.
   */
  entries: readonly EntryRecord[]
  /** The exclusive `api.history` cursor for entries the stream left out; absent when it sent them all. */
  older?: number
  /** `pi.agent`: model, thinking level, cwd, extensions, tools. */
  agent: AgentState
  /** `pi.usage`: spend per model and per tool. */
  usage: UsageState
  /** `pi.live`: the run, the streaming partial, running tools, retries, compactions. */
  live: LiveState
  /** `pi.inbox`: queued steers, follow-ups, and writes. */
  inbox: readonly InboxItem[]
  /** A run is in progress. */
  busy: boolean
  view?: StreamedView
}

const empty: ConversationState = {
  loading: true,
  entries: [],
  agent: {},
  usage: { models: {}, tools: {} },
  live: {},
  inbox: [],
  busy: false,
}
const derived = new WeakMap<StreamedView, ConversationState>()
function derive(view: StreamedView | undefined): ConversationState {
  if (!view) return empty
  let state = derived.get(view)
  if (!state) {
    const docs = view.docs as Readonly<Record<string, JsonObject | undefined>>
    const live = (docs['pi.live'] ?? {}) as LiveState
    state = {
      id: view.conversation.id,
      loading: false,
      entries: view.entries,
      older: view.before === undefined ? undefined : view.before + 1,
      agent: docs['pi.agent'] ?? {},
      usage: (docs['pi.usage'] ?? empty.usage) as UsageState,
      live,
      inbox: (docs['pi.inbox'] as { items?: InboxItem[] } | undefined)?.items ?? [],
      busy: !!live.run,
      view,
    }
    derived.set(view, state)
  }
  return state
}

/**
 * The scoped (or shown) conversation's replica, or the part `select` picks: it re-renders only when that part changes, which
 * matters for anything rendered per transcript row while a run streams.
 */
export function useConversation(): ConversationState
export function useConversation<T>(select: (conversation: ConversationState) => T): T
export function useConversation<T>(select?: (conversation: ConversationState) => T) {
  const id = useContext(ConversationIdContext)
  return useStore((state) => {
    const conversation = derive(id === undefined ? state.view : state.viewsOf[id])
    return select ? select(conversation) : conversation
  })
}
/**
 * The shown conversation now, or the streamed conversation `id` (a command's `context.conversationId`), outside React:
 * for commands and callbacks. Components use `useConversation()`.
 */
export const getConversation = (id?: number): ConversationState => {
  const { view, viewsOf } = store.getState()
  return derive(id === undefined || id === view?.conversation.id ? view : viewsOf[id])
}
/** The whole client state now, outside React (`useStore` inside). */
export const getState = (): State => store.getState()
export const useSystem = () => useStore((state) => state.system)
export const useConversations = () => useStore((state) => state.conversations)
/**
 * One conversation's summary: it re-renders only when that row changes, not when another conversation's busy, title or
 * answer time does. Use it instead of `useConversations().find(…)`.
 */
export const useConversationSummary = (id: number | undefined) =>
  useStore((state) =>
    id === undefined ? undefined : state.conversations.find((summary) => summary.id === id),
  )
/** The live task graph of every conversation. */
export const useTasks = () => useStore((state) => state.tasks)
/** `GET /api/models`, refreshed after (re)connects and by `refreshModels()`. */
export const useModels = () => useStore((state) => state.models)
/** Fetch `GET /api/models` again, such as after a login or logout changed which models are available. */
export const refreshModels = () => store.refreshModels()
export const useNotices = () => useStore((state) => state.notices)
/** Stream state: connecting, open, or reconnecting. */
export const useConnection = () => useStore((state) => state.connection)

/**
 * The document `ref` names (an extension's `refs.ts`; `export const docs` of its server facet) on the scoped
 * conversation, or the shown one outside a scope; null until created.
 */
export function useDoc<T>(ref: DocRef<T>): Readonly<T> | null | undefined {
  return useDocKind(ref.kind) as Readonly<T> | null | undefined
}

/** A document of the scoped (or shown) conversation by kind, untyped: for views such as the documents panel. */
export function useDocKind(kind: string): Readonly<JsonObject> | null | undefined {
  const id = useContext(ConversationIdContext)
  useEffect(
    () => (id === undefined ? store.watchDoc(kind) : store.watchDocOf(id, kind)),
    [id, kind],
  )
  return useStore((state) => (id === undefined ? state.docs[kind] : state.docsOf[id]?.[kind]))
}

/**
 * The document `ref` names on conversation `conversation`, shown or not, such as the root's; `undefined` while
 * `conversation` is undefined and until its stream delivers it. Every hook on one conversation shares one stream.
 */
export function useDocOf<T>(
  conversation: number | undefined,
  ref: DocRef<T>,
): Readonly<T> | null | undefined {
  const { kind } = ref
  useEffect(
    () => (conversation === undefined ? undefined : store.watchDocOf(conversation, kind)),
    [conversation, kind],
  )
  return useStore((state) =>
    conversation === undefined ? undefined : state.docsOf[conversation]?.[kind],
  ) as Readonly<T> | null | undefined
}

const eventFeed = docRef<{ events: EventRecord[] }>(EVENT_FEED)

/**
 * The newest durable events (`host.emit`), newest first and live; only those of `events` when given. Reads the root's
 * feed of the latest 100 events of every kind, so a rare kind can show fewer than `limit`. `undefined` until it arrives.
 */
export function useEvents<T extends EventToken = EventToken>(
  options: { events?: readonly T[]; limit?: number } = {},
): readonly EventRecord<EventData<T>>[] | undefined {
  const feed = useDocOf(ROOT, eventFeed)
  const kinds = options.events?.map((event) => event.kind).join(',')
  const limit = options.limit ?? 20
  return useMemo(() => {
    if (feed === undefined) return undefined
    const wanted = kinds?.split(',')
    return (feed?.events ?? [])
      .filter((event) => !wanted || wanted.includes(event.kind))
      .toReversed()
      .slice(0, limit) as EventRecord<EventData<T>>[]
  }, [feed, kinds, limit])
}

/** The scoped (or shown) conversation id, the shell's surface id and its global actions. */
export function useUltimate(): UltimateContext {
  const scoped = useContext(ConversationIdContext)
  const shown = useConversation((conversation) => conversation.id)
  const conversationId = scoped ?? shown
  const surface = useStore((state) => state.ui.surface?.id) ?? HOME
  return useMemo(() => ({ ...actions, conversationId, surface }), [conversationId, surface])
}

/** `shownSurface()` that re-renders when the facets, the choice, or the project's default change. */
export function useShownSurface() {
  const records = useExtensions()
  const [chosen] = useUiState<JsonValue>(shellKeys.surface, null)
  const preferred = useStore((state) => state.system?.project.settings.defaultSurface)
  return shownSurface(records, chosen, preferred)
}

/**
 * Durable UI state under `key`, stored with the main conversation (`ultimate.ui`): it survives reloads and restarts
 * and is shared by every tab, so the UI resumes where it was. Values are JSON; keys use `[A-Za-z0-9_.:-]`. The setter
 * takes a value or an updater and applies at once.
 */
export function useUiState<T extends JsonValue>(
  key: string,
  initial: T,
): [Widen<T>, (next: Widen<T> | ((previous: Widen<T>) => Widen<T>)) => void] {
  const stored = useSyncExternalStore(uiState.subscribe, () => uiState.get(key))
  const fallback = useRef(initial)
  fallback.current = initial
  const set = useCallback(
    (next: Widen<T> | ((previous: Widen<T>) => Widen<T>)) => {
      const previous = (uiState.get(key) ?? fallback.current) as Widen<T>
      uiState.set(key, typeof next === 'function' ? next(previous) : next)
    },
    [key],
  )
  return [(stored ?? initial) as Widen<T>, set]
}
/** Whether the sidebar or the panel is open: shared on a desktop, this tab's own below it (viewport.ts). */
export function useRegionOpen(region: Region) {
  const [key, fallback] = regionKeys[region]
  const [shared] = useUiState<boolean>(key, fallback)
  const on = useViewport()
  const own = useStore((state) =>
    on === 'desktop' ? false : (state.ui.open?.[on]?.[region] ?? ownDefault(region, on)),
  )
  return on === 'desktop' ? shared : own
}
/**
 * The right panel's state: whether it is open, the panel it shows (the chosen one, else the first with a tab) and the
 * panels in its tab row.
 */
export function usePanels() {
  const panels = panelItems(useExtensions())
  const open = useRegionOpen('panels')
  const [selected] = useUiState<string | null>(shellKeys.panel, null)
  return { open, ...shownPanels(panels, selected) }
}
/** `true` → boolean, `'a'` → string: an initial value names its type, not the only value. */
export type Widen<T> = T extends boolean
  ? boolean
  : T extends string
    ? string
    : T extends number
      ? number
      : T

/**
 * The entries the transcript around a contribution has loaded, oldest first: the active context and any earlier
 * history the reader paged in. Entry renderers and message contributions relate an entry to its neighbours with it.
 */
export function useTranscript(): readonly EntryRecord[] {
  const entries = useContext(TranscriptContext)
  const scoped = useContext(ConversationIdContext)
  const active = useConversation((conversation) => conversation.entries)
  return entries ?? (scoped === undefined ? empty.entries : active)
}

/** The extension whose contribution is rendering; the shell provides it. */
export const ExtensionNameContext = createContext<string | undefined>(undefined)

/** `useUiState` under `ext.<extension name>.<key>`, for state an extension's UI keeps across reloads. */
export function useExtensionUiState<T extends JsonValue>(
  key: string,
  initial: T,
): [Widen<T>, (next: Widen<T> | ((previous: Widen<T>) => Widen<T>)) => void] {
  const extension = useContext(ExtensionNameContext)
  if (!extension) throw new Error('useExtensionUiState works inside an extension contribution only')
  return useUiState(`ext.${extension}.${key}`, initial)
}

/** Whether dialog `id` is open, and a setter; `useUltimate().open(id)` opens it from anywhere. */
export function useDialog(id: string): [boolean, (open: boolean) => void] {
  const open = useStore((state) => state.ui.dialogs[id] === true)
  return [open, (next: boolean) => (next ? actions.open(id) : actions.close(id))]
}

/** Installed web facets, in folder order. */
export function useExtensions() {
  return useSyncExternalStore(registry.subscribe, registry.getSnapshot)
}
const compactFailures = new Set<string>()
/** Reports a `compact.when` that threw once per message, as a notice naming its extension. */
function reportCompact(extension: string, error: unknown) {
  const message = `extension ${extension}: compact is off, its when() threw: ${errorMessage(error)}`
  if (compactFailures.has(message)) return
  compactFailures.add(message)
  // Predicates run while React renders the transcript; notify after that render.
  queueMicrotask(() => store.notify({ level: 'error', message }))
}
const noDocs = {}
/**
 * Which calls stay visible when the shown conversation uses compact mode (`compact` contributions), else `undefined`; it
 * follows the root documents the contributions' tests read.
 */
export function useCompact(): ((call: ToolCall) => boolean) | undefined {
  const { compact, docs } = useCompactConfig()
  return useMemo(() => compact && ((call: ToolCall) => compact.keeps(call, docs)), [compact, docs])
}
/**
 * Which rows of the shown compact transcript are the thread the reader follows, and the line a receded stretch between
 * them shows (`compact` contributions' `thread` and `summary`), else `undefined`.
 */
export function useCompactThread() {
  const { compact, docs } = useCompactConfig()
  return useMemo(() => {
    const thread = compact?.thread
    return thread && { test: (row: CompactRow) => thread(row, docs), summary: compact.summary }
  }, [compact, docs])
}
function useCompactConfig() {
  const records = useExtensions()
  const id = useConversation((conversation) => conversation.id)
  const conversation = useConversationSummary(id)
  const kinds = useMemo(() => compactDocs(records).join(','), [records])
  useEffect(() => {
    const releases = kinds ? kinds.split(',').map((kind) => store.watchDocOf(1, kind)) : []
    return () => releases.forEach((release) => release())
  }, [kinds])
  const docs = useStore((state) => (kinds ? state.docsOf[1] : undefined)) ?? noDocs
  const compact = useMemo(
    () => compactTools(records, conversation, docs, reportCompact),
    [records, conversation, docs],
  )
  return { compact, docs }
}
/** Document renderers by kind (`documents` contributions); the Documents tab shows the rest as JSON. */
export function useDocumentRenderers() {
  const records = useExtensions()
  return useMemo(() => documentItems(records), [records])
}
/** `t(text, values?)` for the `language` setting: the translation of English `text`, else `text` itself. */
export function useT(): Translate {
  const language = useStore((state) => state.system?.language)
  const records = useExtensions()
  return useMemo(() => translator(language, records), [language, records])
}
/** Core and extension commands. */
export function useCommands() {
  const records = useExtensions()
  const t = useT()
  return useMemo(() => allCommands(records, t), [records, t])
}

export interface Restart {
  /** The generation the supervisor accepted, until it serves. */
  pending?: number
  /** Asking the supervisor, or waiting for the new generation. */
  busy: boolean
  /** Why the last restart did not take: a failed type check or boot, or an activation that was rolled back. */
  error?: string
  run: () => void
  /** Forget the last error. */
  clear: () => void
}

/**
 * `api.restart()` with its outcome. The stream drops while the core swaps; the first system info after it reconnects
 * shows either the new generation (done) or the old one (the new core failed to activate and was rolled back).
 */
export function useRestart(timeoutMs = 120000): Restart {
  const system = useStore((state) => state.system)
  const connection = useStore((state) => state.connection.status)
  const [state, setState] = useState<{
    phase: 'idle' | 'asking' | 'swapping'
    target?: number
    /** System info when the stream dropped; a different object after reconnecting is fresh. */
    dropped?: object
    error?: string
  }>({ phase: 'idle' })
  const serving = system?.process.generation ?? 0
  useEffect(() => {
    if (state.phase !== 'swapping' || state.target === undefined) return undefined
    if (serving >= state.target) {
      setState({ phase: 'idle' })
      return undefined
    }
    if (connection !== 'open' && !state.dropped) {
      setState({ ...state, dropped: system ?? {} })
      return undefined
    }
    if (state.dropped && connection === 'open' && system && system !== state.dropped) {
      setState({
        phase: 'idle',
        error: `Generation ${state.target} failed to activate and was rolled back; generation ${serving} keeps serving. The reason is in the supervisor's output.`,
      })
      return undefined
    }
    const timer = setTimeout(
      () =>
        setState({
          phase: 'idle',
          error: `Generation ${state.target} did not start serving within ${Math.round(timeoutMs / 1000)} s.`,
        }),
      timeoutMs,
    )
    return () => clearTimeout(timer)
  }, [state, serving, connection, system, timeoutMs])
  return {
    pending: state.phase === 'swapping' ? state.target : undefined,
    busy: state.phase !== 'idle',
    error: state.error,
    clear: () => setState({ phase: 'idle' }),
    run: () => {
      setState({ phase: 'asking' })
      api.restart().then(
        (result) => {
          const target = (result as { generation?: number } | undefined)?.generation
          setState(target === undefined ? { phase: 'idle' } : { phase: 'swapping', target })
        },
        (error: unknown) => setState({ phase: 'idle', error: errorMessage(error) }),
      )
    },
  }
}

export interface ActionState<T> {
  /** The latest result; kept while a refetch runs, cleared when the action or its args change. */
  data?: T
  /** Why the latest call failed; cleared by the next success. */
  error?: ActionError
  /** A call is in flight. */
  loading: boolean
  /**
   * Call again with the same args (also when `enabled` is false); resolves with the result, or undefined when the call
   * failed or was aborted by a newer call, new args, or an unmount.
   */
  refetch: () => Promise<T | undefined>
}

/** Options of `useAction`. */
export type UseActionOptions = {
  enabled?: boolean
  onError?: (error: ActionError) => void
  /** Call again whenever this value changes (compared as JSON), such as a document, an event id or a busy flag. */
  on?: unknown
  /** Call again this many ms after the last answer, while enabled. */
  every?: number
  /** Call again when the window regains focus. */
  focus?: boolean
}

/**
 * Call the server action `ref` names and keep its result: on mount, whenever the action or `args` (compared as JSON)
 * change, when `on` changes, every `every` ms, on focus with `focus`, and after the server restarts; never while
 * `enabled` is false. Components reading the same action and args share one call and one result, so a remount shows
 * the last answer at once while it asks again. A newer call aborts the older one. Calls act on the nearest conversation scope, or the shown conversation outside one. A failure
 * shows as a notice unless a reader passes `onError`.
 */
export function useAction<Args, T>(
  ref: ActionRef<Args, T>,
  ...[args, options = {}]: ActionArgs<Args, UseActionOptions>
): ActionState<T> {
  // The conversation the call acts on, scoped or shown, keys the read: answers of another conversation never serve it.
  const scoped = useContext(ConversationIdContext)
  const shown = useStore((state) => state.view?.conversation.id ?? state.requested ?? ROOT)
  const read = reads.get(ref.extension, ref.name, args, scoped ?? shown)
  const state = useSyncExternalStore(read.subscribe, read.get)
  const enabled = options.enabled !== false
  const reader = useRef<Reader>({}).current
  reader.onError = options.onError
  reader.focus = options.focus
  reader.every = options.every
  useEffect(() => (enabled ? read.use(reader) : undefined), [read, reader, enabled])
  useEffect(() => read.repoll(), [read, options.every])
  const on = JSON.stringify(options.on ?? null)
  const seen = useRef(on)
  useEffect(() => {
    if (seen.current === on) return
    seen.current = on
    // oxlint-disable-next-line typescript/no-floating-promises -- a read reports failures and resolves undefined rather than rejecting.
    if (enabled) void read.refetch()
  }, [read, on, enabled])
  return {
    data: state.data as T | undefined,
    error: state.error,
    loading: state.loading || (enabled && !state.settled),
    refetch: read.refetch as () => Promise<T | undefined>,
  }
}

/** `copy(text)` puts text on the clipboard; `copied` is true for 1.2 s after, and a failure becomes an error notice. */
export function useCopy() {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const copy = (text: string) =>
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true)
        clearTimeout(timer.current)
        timer.current = setTimeout(() => setCopied(false), 1200)
      })
      .catch((error: unknown) => store.notify({ level: 'error', message: errorMessage(error) }))
  return { copied, copy }
}

/** The current time, updated every `intervalMs` while `active`. */
export function useNow(intervalMs = 1000, active = true): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!active) return undefined
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs, active])
  return now
}

/** Wall time of a tool call from its durable start, ticking while it runs; undefined when it has no times. */
export function useToolDuration(call: ToolCallView): string | undefined {
  const running = call.startedAt !== undefined && call.endedAt === undefined
  const now = useNow(100, running)
  if (call.startedAt === undefined) return undefined
  // The start is the server's clock; a browser clock behind it must not show a negative time.
  return formatDuration(Math.max(0, (call.endedAt ?? now) - call.startedAt))
}
