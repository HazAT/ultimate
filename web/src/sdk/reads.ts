import type { ConversationId } from '@earendil-works/pi-durable'
import { actionRef } from '../../../shared/extension-api.ts'
import { retryAfter } from '../../../lib/timers.ts'
import type { Cancel } from '../../../lib/timers.ts'
import { actionMessage } from './api.ts'
import type { ActionArgs, ActionError, ActionOptions, Api } from './api.ts'
import type { Store } from './store.ts'

export interface Reader {
  onError?: (error: ActionError) => void
  every?: number
  focus?: boolean
}

export interface ReadState {
  data?: unknown
  error?: ActionError

  loading: boolean

  settled: boolean
}
export interface Read {
  get: () => ReadState
  subscribe: (listener: () => void) => () => void

  use: (reader: Reader) => () => void

  refetch: () => Promise<unknown>

  repoll: () => void
}

const MAX_RETAINED_IDLE_READS = 50

const REMOUNT_FRESHNESS_MS = 2000

export function createReads(api: Api, store: Store) {
  const reads = new Map<string, Read & { readers: Set<Reader>; answered: () => boolean }>()
  const changed = new Set<() => void>()
  const inUseReadsSettled = () =>
    [...reads.values()].every((read) => !read.readers.size || read.answered())

  const networkFailedReads = new Set<Read & { readers: Set<Reader> }>()
  function retryNetworkFailedReads() {
    for (const read of networkFailedReads) if (read.readers.size) void read.refetch()
  }
  let process: string | undefined
  let connection = store.getState().connection.status
  store.subscribe(() => {
    const status = store.getState().connection.status
    if (status !== connection) {
      connection = status
      if (status === 'open') retryNetworkFailedReads()
    }
    const system = store.getState().system
    const next = system && `${system.process.pid}:${system.process.generation}`
    if (next === process) return
    const restarted = process !== undefined
    process = next
    if (restarted) for (const read of reads.values()) if (read.readers.size) void read.refetch()
  })
  if (typeof window !== 'undefined')
    window.addEventListener('focus', () => {
      for (const read of reads.values())
        if ([...read.readers].some((reader) => reader.focus)) void read.refetch()
    })
  if (typeof window !== 'undefined') window.addEventListener('online', retryNetworkFailedReads)
  if (typeof document !== 'undefined')
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') retryNetworkFailedReads()
    })

  function evictOldestIdleReads() {
    const idle = [...reads].filter(([, other]) => !other.readers.size)
    for (const [stale] of idle.slice(0, Math.max(0, idle.length - MAX_RETAINED_IDLE_READS)))
      reads.delete(stale)
  }

  function create(
    key: string,
    extension: string,
    name: string,
    args: unknown,
    conversationId?: ConversationId,
  ) {
    let state: ReadState = { loading: false, settled: false }
    const listeners = new Set<() => void>()
    const readers = new Set<Reader>()
    let controller: AbortController | undefined
    let sameTickRequest: Promise<unknown> | undefined
    let cancelPoll: Cancel | undefined
    let lastAnswerAtMs = 0
    let answered = false
    const set = (change: Partial<ReadState>) => {
      state = { ...state, ...change }
      for (const listener of listeners) listener()
      for (const listener of changed) listener()
    }
    function repoll() {
      cancelPoll?.()
      const every = Math.min(...[...readers].map((reader) => reader.every ?? Infinity))
      if (every !== Infinity && !controller) cancelPoll = retryAfter(every, () => void run())
    }
    async function run() {
      controller?.abort()
      cancelPoll?.()
      const own = new AbortController()
      controller = own

      const firstReaderErrorHandlerAtCallStart = [...readers].find(
        (reader) => reader.onError,
      )?.onError
      set({ loading: true })
      try {
        const data = await api.action(
          actionRef<unknown, unknown>(extension, name),
          ...([args, { signal: own.signal, conversationId }] as ActionArgs<unknown, ActionOptions>),
        )
        if (own.signal.aborted) return undefined
        answered = true
        lastAnswerAtMs = Date.now()
        networkFailedReads.delete(read)
        set({ data, error: undefined, loading: false, settled: true })
        return data
      } catch (error) {
        if (own.signal.aborted) return undefined
        answered = true
        const failure = error as ActionError

        const silentRetryableFailure = failure.status === 0
        if (silentRetryableFailure) {
          networkFailedReads.add(read)
          set({ loading: false })
          return undefined
        }
        networkFailedReads.delete(read)
        set({ error: failure, loading: false, settled: true })

        if (firstReaderErrorHandlerAtCallStart) firstReaderErrorHandlerAtCallStart(failure)
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
      answered: () => answered,
      subscribe(listener: () => void) {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
      use(reader: Reader) {
        reads.delete(key)
        reads.set(key, read)
        readers.add(reader)

        const needsFreshCallAfterRemount =
          !controller && !sameTickRequest && Date.now() - lastAnswerAtMs > REMOUNT_FRESHNESS_MS
        if (needsFreshCallAfterRemount) void read.refetch()
        else repoll()
        return function releaseReaderKeepingInFlightCall() {
          readers.delete(reader)
          if (readers.size) return repoll()

          cancelPoll?.()
          networkFailedReads.delete(read)
          evictOldestIdleReads()
          for (const listener of changed) listener()
        }
      },
      refetch() {
        sameTickRequest ??= Promise.resolve().then(() => {
          sameTickRequest = undefined
          return run()
        })
        return sameTickRequest
      },
      repoll,
    }
    return read
  }

  return {
    settledInUse(signal?: AbortSignal) {
      return new Promise<void>((resolve, reject) => {
        const stop = () => {
          changed.delete(check)
          signal?.removeEventListener('abort', abort)
        }
        const check = () => {
          if (!inUseReadsSettled()) return
          stop()
          resolve()
        }
        const abort = () => {
          stop()
          reject(signal!.reason)
        }
        signal?.addEventListener('abort', abort, { once: true })
        changed.add(check)
        if (signal?.aborted) abort()
        else check()
      })
    },
    get(extension: string, name: string, args: unknown, conversationId?: ConversationId): Read {
      const key = JSON.stringify([extension, name, args ?? null, conversationId ?? null])
      let read = reads.get(key)
      if (!read) {
        const [, , argsOfKey] = JSON.parse(key) as [string, string, unknown]
        read = create(key, extension, name, argsOfKey, conversationId)
        reads.set(key, read)
        evictOldestIdleReads()
      }
      return read
    },
  }
}
