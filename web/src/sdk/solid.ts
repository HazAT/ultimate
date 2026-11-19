/**
 * The extension SDK for Solid facets (`*.solid.tsx`): live documents, durable UI state and client state as accessors.
 * Mount a Solid component from a `web.tsx` with `island` from `@/sdk`; docs/extensions/sdk.md#solid-facets.
 */
import type { ConversationId } from '@earendil-works/pi-durable'
import type { JsonValue } from '@earendil-works/chord/json'
import { apply } from '@earendil-works/chord/delta'
import {
  createContext,
  createEffect,
  createMemo,
  createRoot,
  createSignal,
  createStore,
  onSettled,
  runWithOwner,
  useContext,
} from 'solid-js'
import type { Accessor } from 'solid-js'
import type { DocRef } from '../../../shared/extension-api.ts'
import { store, uiState } from './client.ts'
import type { Widen } from './hooks.ts'
import type { DocEvent, State } from './store.ts'

export { api } from './client.ts'
export { ROOT } from './api.ts'
export { actionRef, docRef } from '../../../shared/extension-api.ts'
export { formatAgo, formatBytes, formatDuration, formatTime, formatTokens } from './format.ts'
export { formatKeys } from './keys.ts'
export { cn } from 'cn'

/** The extension whose contribution renders here; `island` provides it. */
export const ExtensionName = createContext<string | null>(null)
/** The conversation `useDoc` reads, as React's `ConversationScope` gives it; null reads the shown conversation. */
export const ConversationScope = createContext<ConversationId | null>(null)

type Target = ConversationId | 'shown'
type Doc = JsonValue | null | undefined

const replicaKey = (target: Target, kind: string) => `${target}:${kind}`
const immutableDoc = (state: State, target: Target, kind: string): Doc =>
  target === 'shown' ? state.docs[kind] : state.docsOf[target]?.[kind]

function createReplica() {
  const [docs, setDocs] = createStore<Record<string, Doc>>({})
  const [state, setState] = createSignal(store.getState())
  const [ui, setUi] = createSignal(uiState.snapshot())
  const watched = new Map<string, { target: Target; kind: string; readers: number }>()

  store.subscribe(() => {
    const current = store.getState()
    setState(current)
    for (const [key, { target, kind }] of watched) {
      const value = immutableDoc(current, target, kind)
      if (value === undefined || value === null)
        setDocs((draft) => {
          if (draft[key] !== value) draft[key] = value
        })
    }
  })
  store.onDocChange((conversation, kind, event: DocEvent) => {
    const key = replicaKey(conversation ?? 'shown', kind)
    if (!watched.has(key)) return
    if ('value' in event) {
      const value = structuredClone(event.value)
      setDocs((draft) => {
        draft[key] = value
      })
      return
    }
    const ops = structuredClone(event.ops)
    setDocs((draft) => {
      const current = draft[key]
      const next = apply(current ?? {}, ops)
      if (next !== current) draft[key] = next
    })
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
      const reader = watched.get(key) ?? { target, kind, readers: 0 }
      if (reader.readers++ === 0) {
        watched.set(key, reader)
        const value = structuredClone(immutableDoc(store.getState(), target, kind))
        setDocs((draft) => {
          draft[key] = value
        })
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

let replica: ReturnType<typeof createReplica> | undefined
const shared = () => (replica ??= runWithOwner(null, () => createRoot(createReplica)))

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
): [Accessor<Widen<T>>, (next: Widen<T> | ((previous: Widen<T>) => Widen<T>)) => void] {
  const { ui } = shared()
  const value = createMemo(() => (ui()[key] ?? initial) as Widen<T>)
  const set = (next: Widen<T> | ((previous: Widen<T>) => Widen<T>)) => {
    const previous = (uiState.get(key) ?? initial) as Widen<T>
    uiState.set(key, typeof next === 'function' ? next(previous) : next)
  }
  return [value, set]
}

/** `useUiState` under `ext.<extension name>.<key>`, for state an extension's UI keeps across reloads. */
export function useExtensionUiState<T extends JsonValue>(key: string, initial: T) {
  const extension = useContext(ExtensionName)
  if (!extension) throw new Error('useExtensionUiState works inside an extension contribution only')
  return useUiState(`ext.${extension}.${key}`, initial)
}

const selected =
  <T>(select: (state: State) => T) =>
  (): Accessor<T> => {
    const { state } = shared()
    return createMemo(() => select(state()))
  }
/** Stream state: connecting, open, or reconnecting. */
export const useConnection = selected((state) => state.connection)
/** Build identity, machine, process, persistence, code, extensions, skills, context files. */
export const useSystem = selected((state) => state.system)
/** Summaries of every conversation; an unchanged row keeps its identity. */
export const useConversations = selected((state) => state.conversations)
