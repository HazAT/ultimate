import type {
  AgentState,
  ConversationId,
  EntryId,
  EntryRecord,
  InboxItem,
  JsonObject,
  LiveState,
  UsageState,
} from '@earendil-works/pi-durable'
import { historyCursorFromStreamBefore } from '../../../shared/protocol.ts'
import type { JsonValue } from '@earendil-works/chord/json'
import {
  createContext,
  createEffect,
  createMemo,
  createRoot,
  createSignal,
  createStore,
  getOwner,
  onSettled,
  reconcile,
  runWithOwner,
  useContext,
} from 'solid-js'
import type { Accessor } from 'solid-js'
import type { ActionRef, DocRef } from '../../../shared/extension-api.ts'
import { docRef } from '../../../shared/extension-api.ts'
import { EVENT_FEED } from '../../../shared/events.ts'
import type { EventData, EventRecord, EventToken } from '../../../shared/events.ts'
import { deadline, every } from '../../../lib/timers.shared.ts'
import type { Cancel } from '../../../lib/timers.shared.ts'
import { actions, allCommands, regionKeys, regionOpenOn, shellKeys } from './actions.ts'
import type { Region } from './actions.ts'
import type { CommandItem, ExtensionRecord } from './registry.ts'
import { HOME, panelItems, shownPanels } from './registry.ts'
import { ROOT } from './api.ts'
import type { ActionArgs, ActionError } from './api.ts'
import { api as client, reads, registry, reportCompact, store, uiAgent, uiState } from './client.ts'
import { events } from './events.ts'
import { errorMessage } from './format.ts'
import { restartAccepted, restartPhase, restartTimedOut } from './restart.ts'
import type { RestartPhase } from './restart.ts'
import type { ReadState, Reader } from './reads.ts'
import { extensionUiKey, writeUiState } from './ui-state.ts'
import type { UiUpdate, Widen } from './ui-state.ts'
import type { State } from './store.ts'
import { compactDocs, compactTools } from './registry.ts'
import type { CompactDocs, CompactRow, ComposerTarget } from './types.ts'
import type { ConversationSummary } from '../../../shared/protocol.ts'
import type { ToolCall } from '@earendil-works/pi-ai'
import type { TranscriptFrame } from './transcript-frame.ts'
import { subscribeViewport, viewport } from './viewport.ts'
import type { Viewport } from './viewport.ts'

export { api, bundle, holdReload, switched } from './client.ts'
/**
 * This page's ui-sdk agent bridge (`snapshot`, `query`), with the `act` the browser tool's `ui` steps use, so a label
 * that exactly names one control acts on it: to run an agent's UI steps on the user's own page.
 */
export const pageAgent = () => {
  const bridge = uiAgent.bridge()
  return {
    snapshot: () => bridge.snapshot(),
    query: bridge.query,
    act: uiAgent.act,
  }
}
/** The page's event bus: `events.emit('secrets:open', { name })`; subscribe for a component's life with `useEvent`. */
export { events } from './events.ts'
/**
 * `writingAs(details.source, write)` attributes each server write `write` starts synchronously (a UI-state set, an
 * action) to the agent when `source` is `agent`, the `details.source` a ui-sdk change handler receives; otherwise to
 * the person. Kit controls run their change handlers in it; a write started after an `await` counts as the person's.
 */
export { writingAs } from './writer.ts'
/** Who the write being made now is attributed to, to carry past an `await`: `writingAs(who, …)` at the later write. */
export { writerNow } from './writer.ts'
export { ROOT } from './api.ts'
export { actionRef, docRef } from '../../../shared/extension-api.ts'
export {
  elidePath,
  errorMessage,
  formatAgo,
  formatBytes,
  formatDuration,
  formatTime,
  formatTokens,
  plural,
  prettyName,
  shortenPath,
} from './format.ts'
export { chordOf, formatKeys, isMac } from './keys.ts'
export {
  holdEscape,
  listShortcuts,
  onShortcutsChanged,
  registerShortcut,
  sameKeys,
  useShortcut,
} from './shortcuts.ts'
/** Whether the device types on a touch keyboard, which focusing an input would slide up over the page. */
export { touchKeyboard } from './viewport.ts'
/** The installed link, inline-code and code-block renderers of Markdown, in discovery order (`useExtensions()` records). */
export {
  codeBlockRenderers,
  composerRenderers,
  documentItems,
  entryRenderers,
  inboxRenderer,
  inlineCodeRenderers,
  linkRenderers,
  messageItems,
  provisionsOf,
  toolLine,
  toolRenderers,
} from './registry.ts'
/** A facet's contributions and its values for other extensions' points; `web.solid.tsx` default-exports one. */
export { attention, defineWebExtension, definePoint, provide } from './types.ts'
/** Typed props of tool, entry, inbox and composer renderers. */
export type {
  CommandContribution,
  CompactRow,
  DocumentProps,
  CodeBlockRenderer,
  CompactSummaryProps,
  InlineCodeRenderer,
  LinkRenderer,
  Point,
  UltimateActions,
  UltimateContext,
  WebExtension,
  ComposerTarget,
  DictationSink,
  DictationTake,
  PromptBoxProps,
  PromptInput,
  UploadSource,
  SolidComposerProps,
  SolidInboxProps,
  SolidEntryProps,
  SolidToolProps,
  ToolCallView,
} from './types.ts'
/**
 * The points the core reads: a run's start, the parked runs, a message's reference, the upload target, the empty
 * transcript, the composer's placeholder and talk shortcut, a conversation's kind, a final answer's speaker and where
 * an error card sends its report.
 */
export {
  AnswerSpeaker,
  ComposerPlaceholder,
  ConversationKind,
  Dictation,
  DictationShortcut,
  EmptyTranscript,
  ErrorReport,
  FileUpload,
  MessageReference,
  ParkedRuns,
  PromptRecorder,
  RunStart,
} from './types.ts'
/** Whether `region` overlays the page on `viewport` (a phone's sidebar, a phone's or tablet's panel) instead of docking. */
export { overlays } from './viewport.ts'
/** True while the previous page's picture still covers this one after a reload. */
export { covered } from './resume.ts'
/** A transcript's shared frame: its entries and scroll elements, for the contributions it renders. */
export { createTranscriptFrame } from './transcript-frame.ts'
export { keepLast } from '../../../lib/errors.shared.ts'
export { cn } from 'cn'
/** The transcript's and composer's reading column classes, for a card that sits in that column. */
export { column } from '../app/layout.ts'

/** The name of the extension whose contribution is rendering, or null outside a contribution. */
export const ExtensionName = createContext<string | null>(null)
/** The conversation live readers follow; null follows the conversation shown in the shell. */
export const ConversationScope = createContext<ConversationId | null>(null)
/**
 * Sends what the composer inside it submits somewhere else, such as a new side chat: `value` reads the target, or
 * undefined to send to the conversation; a composer renderer provides it around its `core`.
 */
export const ComposerRedirect = createContext<Accessor<ComposerTarget | undefined>>(() => undefined)
/** The transcript around a contribution: its loaded entries and its scroll elements; null outside one. */
export const Transcript = createContext<TranscriptFrame | null>(null)

/**
 * The surrounding transcript's loaded entries, oldest first: the active context and any earlier history the reader
 * paged in. Outside a transcript, reads the conversation's streamed entries.
 */
export function useTranscript(): Accessor<readonly EntryRecord[]> {
  const frame = useContext(Transcript)
  const conversation = useConversation()
  return frame ? frame.entries : () => conversation().entries
}

type Target = ConversationId | 'shown'
type Doc = JsonValue | null | undefined

const isObject = (value: Doc): value is { [key: string]: JsonValue } | JsonValue[] =>
  typeof value === 'object' && value !== null
const replicaKey = (target: Target, kind: string) => `${target}:${kind}`
const immutableDoc = (state: State, target: Target, kind: string): Doc => {
  const docs = target === 'shown' ? state.docs : state.docsOf[target]
  return docs && Object.hasOwn(docs, kind) ? docs[kind] : undefined
}

function createReplica() {
  const [docs, setDocs] = createStore<Record<string, Doc>>({})
  const [state, setState] = createSignal(store.getState())
  const [ui, setUi] = createSignal(uiState.snapshot())
  const watched = new Map<string, { target: Target; kind: string; readers: number; seen: Doc }>()

  const follow = (key: string, next: Doc) =>
    setDocs((draft) => {
      const current = draft[key]
      const own = structuredClone(next)
      if (isObject(current) && isObject(own)) reconcile(own, null)(current)
      else draft[key] = own
    })
  store.subscribe(() => {
    const current = store.getState()
    setState(current)
    for (const [key, reader] of watched) {
      const value = immutableDoc(current, reader.target, reader.kind)
      if (value === reader.seen) continue
      reader.seen = value
      follow(key, value)
    }
  })
  uiState.subscribe(() => setUi(uiState.snapshot()))

  return {
    state,
    ui,
    read(target: Target, kind: string): Doc {
      const key = replicaKey(target, kind)
      const value = docs[key]
      const beforeTheFirstWatchSettles = value === undefined && !watched.has(key)
      return beforeTheFirstWatchSettles ? immutableDoc(store.getState(), target, kind) : value
    },
    watch(target: Target, kind: string) {
      const release = target === 'shown' ? store.watchDoc(kind) : store.watchDocOf(target, kind)
      const key = replicaKey(target, kind)
      const reader = watched.get(key) ?? {
        target,
        kind,
        readers: 0,
        seen: undefined,
      }
      if (reader.readers++ === 0) {
        watched.set(key, reader)
        reader.seen = immutableDoc(store.getState(), target, kind)
        follow(key, reader.seen)
      }
      return () => {
        if (--reader.readers === 0) {
          watched.delete(key)
          setDocs((draft) => {
            delete draft[key]
          })
        }
        release()
      }
    },
  }
}

const page = createRoot(() => getOwner())
const once = <T>(make: () => T) => {
  let made: { value: T } | undefined
  return () => (made ??= { value: runWithOwner(page, () => createRoot(make)) }).value
}

const shared = once(createReplica)

type DocAccessor<T> = Accessor<Readonly<T> | null | undefined>

/**
 * The document `ref` names on the conversation `ConversationScope` gives, or the shown one, as an accessor that
 * tracks only the parts it reads; null until created, undefined until the stream delivers it.
 */
export function useDoc<T>(ref: DocRef<T>): DocAccessor<T> {
  const docs = shared()
  const target = useContext(ConversationScope) ?? 'shown'
  onSettled(() => docs.watch(target, ref.kind))
  return () => docs.read(target, ref.kind) as Readonly<T> | null | undefined
}

/** The whole document by kind. Each change yields a new value so the Documents panel can also update React views. */
export function useDocKind(kind: Accessor<string>): DocAccessor<JsonObject> {
  const { state } = shared()
  const target = useContext(ConversationScope) ?? 'shown'
  createEffect(kind, (name) =>
    target === 'shown' ? store.watchDoc(name) : store.watchDocOf(target, name),
  )
  return createMemo(
    () => immutableDoc(state(), target, kind()) as ReturnType<DocAccessor<JsonObject>>,
  )
}

/**
 * The document `ref` names on `conversation()`, shown or not, such as the root's; undefined while it is undefined.
 * It follows the accessor to another conversation.
 */
export function useDocOf<T>(
  conversation: Accessor<ConversationId | undefined>,
  ref: DocRef<T>,
): DocAccessor<T> {
  const docs = shared()
  createEffect(conversation, (id) => (id === undefined ? undefined : docs.watch(id, ref.kind)))
  return () => {
    const id = conversation()
    return (id === undefined ? undefined : docs.read(id, ref.kind)) as
      | Readonly<T>
      | null
      | undefined
  }
}

/**
 * Durable UI state under `key`: a value accessor and a setter that applies at once. If `key` is an accessor, both
 * read and write under its current value.
 */
export function useUiState<T extends JsonValue>(
  key: string | Accessor<string>,
  initial: T,
): [Accessor<Widen<T>>, (next: UiUpdate<T>) => void] {
  const { ui } = shared()
  const current = typeof key === 'string' ? () => key : key
  const value = createMemo(() => (ui()[current()] ?? initial) as Widen<T>)
  return [value, (next: UiUpdate<T>) => writeUiState(uiState, current(), initial, next)]
}

/** `useUiState` under `ext.<extension name>.<key>`, for state an extension's UI keeps across reloads. */
export function useExtensionUiState<T extends JsonValue>(key: string, initial: T) {
  return useUiState(extensionUiKey(useContext(ExtensionName), key), initial)
}

/**
 * Options of `useAction`: `on` is an accessor that triggers another call when its value changes (compared as JSON), and
 * `conversation` the one to call it on instead of the scoped or shown one, such as `ROOT` for state that lives there.
 * `every` polls in ms: a number, or a function of the latest answer returning one (undefined stops polling).
 */
export type UseActionOptions<T = unknown> = {
  conversation?: ConversationId
  onError?: (error: ActionError) => void
  on?: Accessor<unknown>
  every?: number | ((data: T | undefined) => number | undefined)
  focus?: boolean
}

/**
 * Calls the server action `ref` with `args`, sharing the result across readers of the same action, args and
 * conversation. `args` may be an accessor: the read follows its value. Refetches on mount, when `on()` changes, at the `every` interval, on focus with `focus`, and after a
 * restart. Read `data`, `error` and `loading` through their accessors, or call `refetch()` directly.
 */
export function useAction<Args, T>(
  ref: ActionRef<Args, T>,
  ...[args, options = {}]: ActionArgs<Args | Accessor<Args>, UseActionOptions<T>>
) {
  const { state } = shared()
  const scope = useContext(ConversationScope)
  const scoped = options.conversation ?? scope
  const read = createMemo(() => {
    let conversation = scoped
    if (conversation == null) {
      const { view, requested } = state()
      conversation = view?.conversation.id ?? requested ?? ROOT
    }
    return reads.get(
      ref.extension,
      ref.name,
      typeof args === 'function' ? (args as Accessor<Args>)() : args,
      conversation,
    )
  })
  const [current, setCurrent] = createSignal<ReadState>(() => read().get())
  const interval = createMemo(() =>
    typeof options.every === 'function'
      ? options.every(current().data as T | undefined)
      : options.every,
  )
  const reader: Reader = { onError: options.onError, focus: options.focus }
  createEffect(
    () => ({ ms: interval(), read: read() }),
    ({ ms, read: next }) => {
      if (reader.every === ms) return
      reader.every = ms
      next.repoll()
    },
  )
  createEffect(read, (next) => {
    const unsubscribe = next.subscribe(() => setCurrent(next.get()))
    const release = next.use(reader)
    return () => {
      unsubscribe()
      release()
    }
  })
  const on = createMemo(() => JSON.stringify(options.on?.() ?? null))
  createEffect(
    () => ({ read: read(), on: on() }),
    (next, previous) => {
      if (previous?.read === next.read && previous.on !== next.on) void next.read.refetch()
    },
  )
  return {
    data: () => current().data as T | undefined,
    error: () => current().error,
    loading: () => current().loading || !current().settled,
    refetch: () => read().refetch() as Promise<T | undefined>,
  }
}

/** The current time, updated every `intervalMs` while `active()`. */
export function useNow(
  intervalMs = 1000,
  active: Accessor<boolean> = () => true,
): Accessor<number> {
  const [now, setNow] = createSignal(Date.now())
  createEffect(active, (on) => {
    if (!on) return undefined
    setNow(Date.now())
    return every(intervalMs, () => setNow(Date.now()))
  })
  return now
}

const selected =
  <T>(select: (state: State) => T) =>
  (): Accessor<T> => {
    const { state } = shared()
    return createMemo(() => select(state()))
  }
/** A slice of client state, as an accessor that updates when the slice changes identity. */
export function useStore<T>(select: (state: State) => T): Accessor<T> {
  return selected(select)()
}
/** Stream state: connecting, open, or reconnecting. */
export const useConnection = selected((state) => state.connection)
/** Build identity, machine, process, persistence, code, extensions, skills, context files. */
export const useSystem = selected((state) => state.system)
/** Summaries of every conversation; an unchanged row keeps its identity. */
export const useConversations = selected((state) => state.conversations)
/** The live task graph of every conversation. */
export const useTasks = selected((state) => state.tasks)

const eventFeed = docRef<{ events: EventRecord[] }>(EVENT_FEED)

/**
 * Live durable events (`host.emit`), newest first; only matching kinds when `events` is given. Reads `undefined` until
 * the root's feed arrives.
 */
export function useEvents<T extends EventToken = EventToken>(
  options: { events?: readonly T[]; limit?: number } = {},
): Accessor<readonly EventRecord<EventData<T>>[] | undefined> {
  const feed = useDocOf(() => ROOT, eventFeed)
  return createMemo(() => {
    const value = feed()
    if (value === undefined) return undefined
    const wanted = options.events?.map((event) => event.kind)
    return (value?.events ?? [])
      .filter((event) => !wanted || wanted.includes(event.kind))
      .toReversed()
      .slice(0, options.limit ?? 20) as EventRecord<EventData<T>>[]
  })
}

/** Calls `handler` with each `channel` event on the page's bus while the component is mounted. */
export function useEvent(channel: string, handler: (data: unknown) => void) {
  onSettled(() => events.on(channel, handler))
}

/** The installed web facets, in discovery order. */
export const useExtensions = once((): Accessor<readonly ExtensionRecord[]> => {
  const [records, setRecords] = createSignal(registry.getSnapshot())
  registry.subscribe(() => setRecords(registry.getSnapshot()))
  return records
})

/** Whether extension `name` is on in this page: what an extension that `wants` another shows only while it is. */
export function useEnabled(name: string): Accessor<boolean> {
  const records = useExtensions()
  return () => records().some((record) => record.name === name)
}

/**
 * Page extension readiness: `ready`, `timedOut`, and the names that `failed` or are still `pending`.
 */
export const useReady = once((): Accessor<ReturnType<typeof registry.getReady>> => {
  const [ready, setReady] = createSignal(registry.getReady())
  registry.subscribe(() => setReady(registry.getReady()))
  return ready
})

/** Core and extension commands, as the palette lists them. */
export const useCommands = once((): Accessor<CommandItem[]> =>
  createMemo(() => allCommands(useExtensions()())),
)

/** How much room the window has: `phone`, `tablet` or `desktop`. */
export const useViewport = once((): Accessor<Viewport> => {
  const [current, setCurrent] = createSignal(viewport())
  subscribeViewport(() => setCurrent(viewport()))
  return current
})

/** Shell actions for navigation, commands, panels and composer focus. */
export const { switchConversation, showSurface, runCommand, openPanel, closePanel, focusComposer } =
  actions
/** The composer input a person can type into now (the main one or a side chat's); `dataset.conversation` is its conversation. */
export { uncoveredComposer } from './actions.ts'
/**
 * `fillComposer(id, text)` replaces conversation `id`'s composer draft, `insertIntoComposer(id, text)` inserts at its
 * cursor. `composerDraft(id)` reads the text, images and number of attached files in its composer (`id` may be a `ComposerTarget`'s `draft` key),
 * and `attachments`, the prompt lines of the files that finished uploading;
 * `reserve()` marks the draft as being sent, which locks the box and Enter (undefined when a send already holds it),
 * and returns `release(sent)`: `'all'` or `'attachments'` removes the images and finished files that were sent (and with
 * `'all'` the text) unless they changed meanwhile, nothing keeps it; `subscribe(listener)` hears every change to that draft.
 */
export { composerDraft, fillComposer, insertIntoComposer } from '../app/drafts.ts'

/** The conversation `ConversationScope` gives, or the shown one once known. */
export function useConversationId(): Accessor<ConversationId | undefined> {
  const { state } = shared()
  const scoped = useContext(ConversationScope)
  return createMemo(() => scoped ?? state().view?.conversation.id)
}

/** Conversation `id()`'s summary (title, label, busy, parent), updating only when that row changes. */
export function useConversationSummary(
  id: Accessor<ConversationId | undefined>,
): Accessor<ConversationSummary | undefined> {
  const { state } = shared()
  return createMemo(() => {
    const wanted = id()
    return wanted === undefined
      ? undefined
      : state().conversations.find((summary) => summary.id === wanted)
  })
}

/**
 * Accessors for the surrounding transcript's scroll element and the element containing its rows (`data-entry-id`).
 * Both read null outside a transcript or before it mounts.
 */
export function useTranscriptElements() {
  const frame = useContext(Transcript)
  return {
    scroll: () => frame?.elements()?.scroll ?? null,
    content: () => frame?.elements()?.content ?? null,
  }
}

/** `pi.agent` of the conversation `ConversationScope` gives, or the shown one: model, thinking level, cwd, tools. */
export function useAgent(): Accessor<AgentState> {
  const view = useScopedView()
  return createMemo(() => view()?.docs['pi.agent'] ?? {})
}

/** The active surface's id, or `agent` until the shell opens another surface. */
export const useSurface = selected((state) => state.ui.surface?.id ?? HOME)

/** The page's notice stack, oldest first. */
export const useNotices = selected((state) => state.notices)
/** Refetches the model list, for example after signing in to a provider. */
export const refreshModels = () => store.refreshModels()

/** Whether the sidebar or the right panel is open on this viewport, as the shell shows it. */
export function useRegionOpen(region: Region): Accessor<boolean> {
  const [key, fallback] = regionKeys[region]
  const [desktop] = useUiState<boolean>(key, fallback)
  const { state } = shared()
  const on = useViewport()
  return createMemo(() => regionOpenOn(region, on(), desktop(), state().ui.open))
}

/**
 * Accessors for whether the right panel is open, the panel it shows (the chosen one, else the first with a tab), and
 * the panels in its tab row.
 */
export function usePanels() {
  const extensions = useExtensions()
  const open = useRegionOpen('panels')
  const [chosen] = useUiState<string | null>(shellKeys.panel, null)
  const panels = createMemo(() => shownPanels(panelItems(extensions()), chosen()))
  return { open, active: () => panels().active, tabs: () => panels().tabs }
}

/** An accessor for whether dialog `id` is open, and a setter. */
export function useDialog(id: string): [Accessor<boolean>, (open: boolean) => void] {
  const { state } = shared()
  const open = createMemo(() => state().ui.dialogs[id] === true)
  return [open, (next) => (next ? actions.open(id) : actions.close(id))]
}

/** `GET /api/models`: providers with auth status, models with context window and cost; undefined until it arrives. */
export const useModels = selected((state) => state.models)

const noUsage: UsageState = { models: {}, tools: {} }
const noLive: LiveState = {}
const noEntries: readonly EntryRecord[] = []

/**
 * The scoped or shown conversation's live state: `id`,
 * `loading`, its streamed `entries` (oldest first), the `older` history cursor, `agent` (`pi.agent`), `usage`
 * (`pi.usage`), `live` (`pi.live`), `inbox` (`pi.inbox`: queued steers, follow-ups and writes) and `busy` while a run is
 * in progress.
 */
export type ConversationState = {
  id?: ConversationId
  loading: boolean
  entries: readonly EntryRecord[]
  older?: EntryId
  agent: AgentState
  usage: UsageState
  live: LiveState
  inbox: readonly InboxItem[]
  busy: boolean
}

function useScopedView() {
  const { state } = shared()
  const scoped = useContext(ConversationScope)
  return createMemo(() => (scoped === null ? state().view : state().viewsOf[scoped]))
}

function conversationState(shown: State['view']): ConversationState {
  const live = (shown?.docs['pi.live'] ?? noLive) as LiveState
  return {
    id: shown?.conversation.id,
    loading: !shown,
    entries: shown?.entries ?? noEntries,
    older: historyCursorFromStreamBefore(shown?.before),
    agent: shown?.docs['pi.agent'] ?? {},
    usage: (shown?.docs['pi.usage'] ?? noUsage) as UsageState,
    live,
    inbox: (shown?.docs['pi.inbox'] as { items?: InboxItem[] } | undefined)?.items ?? noInbox,
    busy: !!live.run,
  }
}

export function useConversation(): Accessor<ConversationState> {
  const view = useScopedView()
  return createMemo(() => conversationState(view()))
}

/** The shown conversation now, or the streamed conversation `id`, outside a component: for commands and callbacks. */
export function getConversation(id?: ConversationId): ConversationState {
  const { view, viewsOf } = store.getState()
  return conversationState(id === undefined || id === view?.conversation.id ? view : viewsOf[id])
}

/** Writes durable UI state `key` outside a component (a command), as `useUiState`'s setter does. */
export const setUiState = (key: string, value: JsonValue) => uiState.set(key, value)

/** The whole client state now, outside a component. */
export const getState = (): State => store.getState()
const noInbox: readonly InboxItem[] = []

/**
 * How the scoped or shown conversation folds when it uses compact mode (`compact` contributions), else undefined:
 * `keeps(call)` for calls that stay visible, `thread` and `summary` for its receded stretches. It follows the root
 * documents the contributions read.
 */
export function useCompact() {
  const records = useExtensions()
  const { state } = shared()
  const id = useConversationId()
  const kinds = createMemo(() => compactDocs(records()).join(','))
  createEffect(kinds, (joined) => {
    const releases = joined ? joined.split(',').map((kind) => store.watchDocOf(ROOT, kind)) : []
    return () => releases.forEach((release) => release())
  })
  const docs = createMemo(
    (): CompactDocs =>
      Object.fromEntries(
        kinds()
          .split(',')
          .filter(Boolean)
          .map((kind) => [kind, immutableDoc(state(), ROOT, kind)]),
      ) as CompactDocs,
    { equals: sameDocs },
  )
  const conversation = createMemo(() => {
    const shown = id()
    return shown === undefined
      ? undefined
      : state().conversations.find((summary) => summary.id === shown)
  })
  return createMemo(() => {
    const compact = compactTools(records(), conversation(), docs(), reportCompact)
    if (!compact) return undefined
    const rootDocs = docs()
    const thread = compact.thread
    return {
      keeps: (call: ToolCall) => compact.keeps(call, rootDocs),
      thread: thread && ((row: CompactRow) => thread(row, rootDocs)),
      summary: compact.summary,
    }
  })
}
const sameDocs = (a: CompactDocs, b: CompactDocs) =>
  Object.keys(a).length === Object.keys(b).length &&
  Object.keys(a).every((kind) => Object.hasOwn(b, kind) && a[kind] === b[kind])

/** Shows a notice in the page's notice stack, as a failed command does. */
export const notify = (notice: Parameters<typeof store.notify>[0]) => store.notify(notice)

/**
 * `copy(text)` puts text on the clipboard and returns the Promise a Button shows as pending; `copied()` is true for
 * 1.2 s after, and a failure becomes an error notice.
 */
export function useCopy() {
  const [copied, setCopied] = createSignal(false)
  const reset: { cancel?: Cancel } = {}
  onSettled(() => () => reset.cancel?.())
  const copy = (text: string) =>
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true)
        reset.cancel?.()
        reset.cancel = deadline(1200, () => setCopied(false))
      })
      .catch((error: unknown) => store.notify({ level: 'error', message: errorMessage(error) }))
  return { copied, copy }
}

/**
 * Calls `api.restart()` and tracks its outcome: `busy()` while asking or swapping,
 * `pending()` the generation it waits for, `error()` why the last restart did not take.
 */
export function useRestart(timeoutMs = 120_000) {
  const system = useSystem()
  const connection = useConnection()
  const [state, setState] = createSignal<RestartPhase>({ phase: 'idle' })
  createEffect(
    () => ({
      current: state(),
      system: system(),
      open: connection().status === 'open',
    }),
    ({ current, system: info, open }) => {
      const next = restartPhase(current, info, open)
      if (next !== current) setState(next)
    },
  )
  const swapping = createMemo(() => {
    const current = state()
    return current.phase === 'swapping' ? current.target : undefined
  })
  createEffect(swapping, (target) =>
    target === undefined
      ? undefined
      : deadline(timeoutMs, () => setState(restartTimedOut(target, timeoutMs))),
  )
  return {
    busy: () => state().phase !== 'idle',
    pending: swapping,
    error: () => {
      const value = state()
      return value.phase === 'idle' ? value.error : undefined
    },
    clear: () => setState({ phase: 'idle' }),
    run: () => {
      setState({ phase: 'asking' })
      client.restart().then(
        (result) => setState(restartAccepted(result)),
        (failure: unknown) => setState({ phase: 'idle', error: errorMessage(failure) }),
      )
    },
  }
}
export type { DocumentItem } from './registry.ts'
export type {
  ConversationSummary,
  ModelsResponse,
  Notice,
  SystemInfo,
} from '../../../shared/protocol.ts'
export type { EntryRecord, LiveState } from '@earendil-works/pi-durable'
export type { JsonValue } from '@earendil-works/chord/json'
export type { AuthEvent, AuthPrompt, Usage } from '@earendil-works/pi-ai'
