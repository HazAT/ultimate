/**
 * The extension SDK for Solid facets (`*.solid.tsx`): live documents, durable UI state and client state as accessors.
 * Mount a Solid component from a `web.tsx` with `island` from `@/sdk`; docs/extensions/sdk.md#solid-facets.
 */
import type {
  AgentState,
  ConversationId,
  EntryId,
  EntryRecord,
  InboxItem,
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
import { deadline, every } from '../../../lib/timers.ts'
import type { Cancel } from '../../../lib/timers.ts'
import { actions, allCommands } from './actions.ts'
import type { CommandItem, ExtensionRecord } from './registry.ts'
import { ROOT } from './api.ts'
import type { ActionArgs, ActionError } from './api.ts'
import { api as client, reads, registry, reportCompact, store, uiState } from './client.ts'
import { events } from './events.ts'
import { errorMessage } from './format.ts'
import { restartAccepted, restartPhase, restartTimedOut } from './restart.ts'
import type { RestartPhase } from './restart.ts'
import type { ReadState, Reader } from './reads.ts'
import { extensionUiKey, writeUiState } from './ui-state.ts'
import type { UiUpdate, Widen } from './ui-state.ts'
import type { State } from './store.ts'
import { compactDocs, compactTools } from './registry.ts'
import type { CompactRow, ComposerTarget } from './types.ts'
import type { ConversationSummary } from '../../../shared/protocol.ts'
import type { ToolCall } from '@earendil-works/pi-ai'
import type { TranscriptFrame } from './transcript-frame.ts'
import { subscribeViewport, viewport } from './viewport.ts'
import type { Viewport } from './viewport.ts'

export { api, bundle, switched } from './client.ts'
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
export { formatKeys, isMac } from './keys.ts'
/** Whether the device types on a touch keyboard, which focusing an input would slide up over the page. */
export { touchKeyboard } from './viewport.ts'
/** The installed link, inline-code and code-block renderers of Markdown, in discovery order (`useExtensions()` records). */
export {
  codeBlockRenderers,
  composerRenderers,
  entryRenderers,
  inboxRenderer,
  inlineCodeRenderers,
  linkRenderers,
  messageItems,
  provisionsOf,
  toolLine,
  toolRenderers,
} from './registry.ts'
/** Typed props of Solid tool and entry renderers contributed as `island(Component)`. */
export type {
  ComposerTarget,
  SolidComposerProps,
  SolidInboxProps,
  SolidEntryProps,
  SolidToolProps,
  ToolCallView,
} from './types.ts'
/**
 * The points the core reads: a run's start, the parked runs, a message's reference, the upload target, the empty
 * transcript, the composer's placeholder.
 */
export {
  ComposerPlaceholder,
  EmptyTranscript,
  FileUpload,
  MessageReference,
  ParkedRuns,
  RunStart,
} from './types.ts'
/** True while the previous page's picture still covers this one after a reload. */
export { covered } from './resume.ts'
/** A transcript's shared frame: its entries and scroll elements, for the contributions it renders. */
export { createTranscriptFrame } from './transcript-frame.ts'
export { keepLast } from '../../../lib/errors.ts'
export { cn } from 'cn'
/** The transcript's and composer's reading column classes, for a card that sits in that column. */
export { column } from '../app/layout.ts'

/** The extension whose contribution renders here; `island` provides it. */
export const ExtensionName = createContext<string | null>(null)
/** The conversation `useDoc` reads, as React's `ConversationScope` gives it; null reads the shown conversation. */
export const ConversationScope = createContext<ConversationId | null>(null)
/**
 * Sends what the composer inside it submits somewhere else, such as a new side chat: `value` reads the target, or
 * undefined to send to the conversation; a composer renderer provides it around its `core`.
 */
export const ComposerRedirect = createContext<Accessor<ComposerTarget | undefined>>(() => undefined)
/** The transcript around a contribution: its loaded entries and its scroll elements; null outside one. */
export const Transcript = createContext<TranscriptFrame | null>(null)

/**
 * The entries the transcript around a contribution has loaded, oldest first, as `useTranscript` from `@/sdk` reads them:
 * the active context and any earlier history the reader paged in; outside a transcript, the conversation's streamed ones.
 */
export function useTranscript(): Accessor<readonly EntryRecord[]> {
  const frame = useContext(Transcript)
  const conversation = useConversation()
  if (!frame) return () => conversation().entries
  const [entries, setEntries] = createSignal(frame.entries())
  onSettled(() => {
    setEntries(() => frame.entries())
    return frame.subscribe(() => setEntries(() => frame.entries()))
  })
  return entries
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
      const reader = watched.get(key) ?? { target, kind, readers: 0, seen: undefined }
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

/** Durable UI state under `key`, as `useUiState` from `@/sdk` keeps it: `[value, set]`; the setter applies at once. */
export function useUiState<T extends JsonValue>(
  key: string,
  initial: T,
): [Accessor<Widen<T>>, (next: UiUpdate<T>) => void] {
  const { ui } = shared()
  const value = createMemo(() => (ui()[key] ?? initial) as Widen<T>)
  return [value, (next: UiUpdate<T>) => writeUiState(uiState, key, initial, next)]
}

/** `useUiState` under `ext.<extension name>.<key>`, for state an extension's UI keeps across reloads. */
export function useExtensionUiState<T extends JsonValue>(key: string, initial: T) {
  return useUiState(extensionUiKey(useContext(ExtensionName), key), initial)
}

/**
 * Options of `useAction`: as in `@/sdk`, with `on` an accessor whose value (compared as JSON) calls again, and
 * `conversation` the one to call it on instead of the scoped or shown one, such as `ROOT` for state that lives there.
 */
export type UseActionOptions<T = unknown> = {
  conversation?: ConversationId
  onError?: (error: ActionError) => void
  on?: Accessor<unknown>
  every?: number | ((data: T | undefined) => number | undefined)
  focus?: boolean
}

/**
 * The server action `ref` names, called with `args` as `useAction` from `@/sdk` calls it and sharing its result: on
 * mount, when `on()` changes, every `every` ms (a number, or a function of the latest answer), on focus with `focus`, and after a restart. Each field is an accessor.
 */
export function useAction<Args, T>(
  ref: ActionRef<Args, T>,
  ...[args, options = {}]: ActionArgs<Args, UseActionOptions<T>>
) {
  const { state } = shared()
  const scope = useContext(ConversationScope)
  const scoped = options.conversation ?? scope
  const read = createMemo(() => {
    const { view, requested } = state()
    const conversation = scoped ?? view?.conversation.id ?? requested ?? ROOT
    return reads.get(ref.extension, ref.name, args, conversation)
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
/** A slice of the client state, as `useStore` from `@/sdk` reads it; it updates when the slice changes identity. */
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
 * The newest durable events (`host.emit`), newest first and live, as `useEvents` from `@/sdk` reads them; only those of
 * `events` when given. `undefined` until the root's feed arrives.
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

/** Installed web facets, in folder order, as `useExtensions` from `@/sdk` reads them. */
export const useExtensions = once((): Accessor<readonly ExtensionRecord[]> => {
  const [records, setRecords] = createSignal(registry.getSnapshot())
  registry.subscribe(() => setRecords(registry.getSnapshot()))
  return records
})

/** Core and extension commands, as the palette lists them. */
export const useCommands = once((): Accessor<CommandItem[]> =>
  createMemo(() => allCommands(useExtensions()())),
)

/** How much room the window has, `phone`, `tablet` or `desktop`, as `useViewport` from `@/sdk` reads it. */
export const useViewport = once((): Accessor<Viewport> => {
  const [current, setCurrent] = createSignal(viewport())
  subscribeViewport(() => setCurrent(viewport()))
  return current
})

/** Shell navigation and commands, as `useUltimate()` from `@/sdk` gives them. */
export const { switchConversation, showSurface, runCommand, openPanel, focusComposer } = actions
/** The composer input a person can type into now (the main one or a side chat's); `dataset.conversation` is its conversation. */
export { uncoveredComposer } from './actions.ts'
/**
 * `fillComposer(id, text)` replaces conversation `id`'s composer draft, `insertIntoComposer(id, text)` inserts at its
 * cursor, as in `@/sdk`.
 */
export { fillComposer, insertIntoComposer } from '../app/drafts.ts'

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
 * The transcript around a contribution, as `useTranscriptScroll` from `@/sdk` gives them: its scroll element and the
 * element whose children are its rows (`data-entry-id`); null outside a transcript or before it mounts.
 */
export function useTranscriptElements() {
  const frame = useContext(Transcript)
  return {
    scroll: () => frame?.scroll.current ?? null,
    content: () => frame?.content.current ?? null,
  }
}

/** `pi.agent` of the conversation `ConversationScope` gives, or the shown one: model, thinking level, cwd, tools. */
export function useAgent(): Accessor<AgentState> {
  const view = useScopedView()
  return createMemo(() => view()?.docs['pi.agent'] ?? {})
}

/** The page's notice stack, oldest first, as `useNotices` from `@/sdk` reads it. */
export const useNotices = selected((state) => state.notices)
/** Fetches the model list again, as `refreshModels` from `@/sdk` does, such as after a login changed it. */
export const refreshModels = () => store.refreshModels()

/** Whether dialog `id` is open, and a setter, as `useDialog` from `@/sdk` gives them. */
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
 * The conversation `ConversationScope` gives, or the shown one, as `useConversation` from `@/sdk` reads it: `id`,
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

export function useConversation(): Accessor<ConversationState> {
  const view = useScopedView()
  return createMemo((): ConversationState => {
    const shown = view()
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
  })
}
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
  const docs = createMemo(() => (kinds() ? state().docsOf[ROOT] : undefined) ?? noDocs)
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
const noDocs = {}

/** Shows a notice in the page's notice stack, as a failed command does. */
export const notify = (notice: Parameters<typeof store.notify>[0]) => store.notify(notice)

/** `copy(text)` puts text on the clipboard; `copied()` is true for 1.2 s after, and a failure becomes an error notice. */
export function useCopy() {
  const [copied, setCopied] = createSignal(false)
  const reset: { cancel?: Cancel } = {}
  onSettled(() => () => reset.cancel?.())
  const copy = (text: string) =>
    void navigator.clipboard
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
 * `api.restart()` with its outcome, as `useRestart` from `@/sdk` reports it: `busy()` while asking or swapping,
 * `pending()` the generation it waits for, `error()` why the last restart did not take.
 */
export function useRestart(timeoutMs = 120_000) {
  const system = useSystem()
  const connection = useConnection()
  const [state, setState] = createSignal<RestartPhase>({ phase: 'idle' })
  createEffect(
    () => ({ current: state(), system: system(), open: connection().status === 'open' }),
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
