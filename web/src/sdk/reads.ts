import { actionRef } from '../../../shared/extension-api.ts'
import { actionMessage } from './api.ts'
import type { ActionArgs, ActionError, ActionOptions, Api } from './api.ts'
import type { Store } from './store.ts'

/** What one component reading an action wants: its own error handler, a poll period, refreshing on window focus. */
export interface Reader {
  onError?: (error: ActionError) => void
  every?: number
  focus?: boolean
}
/** A read's result as its readers see it; a new object on every change. */
export interface ReadState {
  data?: unknown
  error?: ActionError
  /** A call is in flight. */
  loading: boolean
  /** A call has settled, so `data` or `error` answers it. */
  settled: boolean
}
export interface Read {
  get: () => ReadState
  subscribe: (listener: () => void) => () => void
  /**
   * Count `reader` in until the returned release runs. A mount asks again unless a call is in flight or answered within
   * `FRESH`, showing the last answer meanwhile.
   */
  use: (reader: Reader) => () => void
  /** Call again; calls asked for in the same tick share one request, and a newer call aborts the older one. */
  refetch: () => Promise<unknown>
  /** Re-plan the poll after a reader changed its `every`. */
  repoll: () => void
}

/** Reads kept for remounts after their last reader left, so a panel opened again shows its data at once. */
const IDLE = 50
/** How long an answer serves a newly mounted reader without asking again. */
const FRESH = 2000

/**
 * The page's action reads (`useAction`), one per action, args and conversation however many components read it:
 * one request in flight, one result. A new server process refetches every read in use, since its answers came from
 * the old one.
 */
export function createReads(api: Api, store: Store) {
  const reads = new Map<string, Read & { readers: Set<Reader> }>()
  let process: string | undefined
  store.subscribe(() => {
    const system = store.getState().system
    const next = system && `${system.process.pid}:${system.process.generation}`
    if (next === process) return
    const restarted = process !== undefined
    process = next
    // oxlint-disable-next-line typescript/no-floating-promises -- a read reports failures and resolves undefined rather than rejecting.
    if (restarted) for (const read of reads.values()) if (read.readers.size) void read.refetch()
  })
  if (typeof window !== 'undefined')
    window.addEventListener('focus', () => {
      for (const read of reads.values())
        // oxlint-disable-next-line typescript/no-floating-promises -- a read reports failures and resolves undefined rather than rejecting.
        if ([...read.readers].some((reader) => reader.focus)) void read.refetch()
    })

  function create(
    key: string,
    extension: string,
    name: string,
    args: unknown,
    conversationId?: number,
  ) {
    let state: ReadState = { loading: false, settled: false }
    const listeners = new Set<() => void>()
    const readers = new Set<Reader>()
    let controller: AbortController | undefined
    let queued: Promise<unknown> | undefined
    let poll: ReturnType<typeof setTimeout> | undefined
    let answered = 0
    const set = (change: Partial<ReadState>) => {
      state = { ...state, ...change }
      for (const listener of listeners) listener()
    }
    function repoll() {
      clearTimeout(poll)
      const every = Math.min(...[...readers].map((reader) => reader.every ?? Infinity))
      if (every !== Infinity && !controller) poll = setTimeout(() => void run(), every)
    }
    async function run() {
      controller?.abort()
      clearTimeout(poll)
      const own = new AbortController()
      controller = own
      set({ loading: true })
      try {
        const data = await api.action(
          actionRef<unknown, unknown>(extension, name),
          ...([args, { signal: own.signal, conversationId }] as ActionArgs<unknown, ActionOptions>),
        )
        if (own.signal.aborted) return undefined
        answered = Date.now()
        set({ data, error: undefined, loading: false, settled: true })
        return data
      } catch (error) {
        if (own.signal.aborted) return undefined
        const failure = error as ActionError
        set({ error: failure, loading: false, settled: true })
        const handlers = [...readers].flatMap((reader) => reader.onError ?? [])
        if (handlers.length) for (const handler of handlers) handler(failure)
        else store.notify({ level: 'error', message: actionMessage(failure) })
        return undefined
      } finally {
        if (controller === own) {
          controller = undefined
          repoll()
        }
      }
    }
    const read = {
      readers,
      get: () => state,
      subscribe(listener: () => void) {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
      use(reader: Reader) {
        // Most recently used last, so the oldest idle reads go first.
        reads.delete(key)
        reads.set(key, read)
        readers.add(reader)
        // A reader joining a call in flight, or an answer just given, takes that one: components of one page mount over
        // several commits, and each asking again aborted the call before it.
        // oxlint-disable-next-line typescript/no-floating-promises -- a read reports failures and resolves undefined rather than rejecting.
        if (!controller && !queued && Date.now() - answered > FRESH) void read.refetch()
        else repoll()
        return () => {
          readers.delete(reader)
          if (readers.size) return repoll()
          // A call in flight finishes: a component remounting at once, as the shell does while its facets load, takes it.
          clearTimeout(poll)
          const idle = [...reads].filter(([, other]) => !other.readers.size)
          for (const [stale] of idle.slice(0, Math.max(0, idle.length - IDLE))) reads.delete(stale)
        }
      },
      refetch() {
        // Effects of one commit, or readers reacting to one change, ask in the same tick: one request answers them.
        queued ??= Promise.resolve().then(() => {
          queued = undefined
          return run()
        })
        return queued
      },
      repoll,
    }
    return read
  }

  return {
    /** The read of `extension/name` with `args` on `conversationId` (the shown conversation when absent). */
    get(extension: string, name: string, args: unknown, conversationId?: number): Read {
      const key = JSON.stringify([extension, name, args ?? null, conversationId ?? null])
      let read = reads.get(key)
      if (!read) {
        read = create(key, extension, name, args, conversationId)
        reads.set(key, read)
      }
      return read
    },
  }
}
