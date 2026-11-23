import type { ConversationId } from '@earendil-works/pi-durable'
import type { JsonValue } from '@earendil-works/chord/json'
import { actionRef } from '../../../shared/extension-api.ts'
import type { ReadEvent, ReadSpec } from '../../../shared/protocol.ts'
import { ActionError, actionMessage } from './api.ts'
import type { ActionArgs, ActionOptions, Api } from './api.ts'
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

export function createReads(api: Api, store: Store) {
  const reads = new Map<string, Read & { readers: Set<Reader>; answered: () => boolean }>()
  const changed = new Set<() => void>()
  const inUseReadsSettled = () =>
    store.getState().connection.status !== 'open' ||
    [...reads.values()].every((read) => !read.readers.size || read.answered())
  let connection = store.getState().connection.status
  store.subscribe(() => {
    const status = store.getState().connection.status
    if (status === connection) return
    connection = status
    for (const listener of changed) listener()
  })

  if (typeof window !== 'undefined')
    window.addEventListener('focus', () => {
      for (const read of reads.values())
        if ([...read.readers].some((reader) => reader.focus)) void read.refetch()
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
    let fetching = false
    let running: Promise<unknown> | undefined
    let queued: Promise<unknown> | undefined
    let answered = false
    let lastAnswer: string | undefined
    let watching: { every: number | undefined; stop: () => void } | undefined
    const spec: ReadSpec = {
      extension,
      action: name,
      args: (args ?? null) as JsonValue,
      ...(conversationId === undefined ? {} : { conversation: conversationId }),
    }
    const set = (change: Partial<ReadState>) => {
      state = { ...state, ...change }
      for (const listener of listeners) listener()
      for (const listener of changed) listener()
    }
    function answer(event: ReadEvent, onError = errorHandler()) {
      answered = true
      const json = JSON.stringify(event)
      if (json === lastAnswer) {
        if (!state.settled || state.loading) set({ settled: true, loading: fetching })
        return
      }
      lastAnswer = json
      if ('result' in event) {
        set({ data: event.result, error: undefined, settled: true, loading: fetching })
        return
      }
      const failure = new ActionError(extension, name, event.status, event.error)
      set({ error: failure, settled: true, loading: fetching })
      if (onError) onError(failure)
      else store.notify({ level: 'error', message: actionMessage(failure) })
    }
    const errorHandler = () => [...readers].find((reader) => reader.onError)?.onError
    function repoll() {
      const every = Math.min(...[...readers].map((reader) => reader.every ?? Infinity))
      const wanted = readers.size ? (every === Infinity ? undefined : every) : null
      if (wanted === null) {
        watching?.stop()
        watching = undefined
        return
      }
      if (watching && watching.every === wanted) return
      watching?.stop()
      watching = { every: wanted, stop: store.watchRead(spec, wanted, (event) => answer(event)) }
    }
    function start(onError: Reader['onError']) {
      const request = Promise.withResolvers<unknown>()
      running = request.promise
      const release = () => {
        if (running === request.promise) running = undefined
      }
      request.promise.then(release, release)
      request.resolve(run(onError))
      return request.promise
    }
    async function run(onError: Reader['onError']) {
      fetching = true
      set({ loading: true })
      try {
        const data = await api.action(
          actionRef<unknown, unknown>(extension, name),
          ...([args, { conversationId }] as ActionArgs<unknown, ActionOptions>),
        )
        settleAttempt({ result: (data ?? null) as JsonValue }, onError)
        return data
      } catch (error) {
        const failure = error as ActionError
        settleAttempt(
          failure.status === 0 ? undefined : { error: failure.message, status: failure.status },
          onError,
        )
        return undefined
      }
    }
    function settleAttempt(event: ReadEvent | undefined, onError: Reader['onError']) {
      fetching = false
      const streamWritesTheSharedAnswer = watching !== undefined
      if (event && !streamWritesTheSharedAnswer) return answer(event, onError)
      if (!streamWritesTheSharedAnswer) answered = true
      set({ loading: fetching })
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
        repoll()
        return function releaseReader() {
          readers.delete(reader)
          repoll()
          if (readers.size) return
          evictOldestIdleReads()
          for (const listener of changed) listener()
        }
      },
      refetch() {
        const onError = errorHandler()
        const go = () => {
          queued = undefined
          return start(onError)
        }
        queued ??= (running ?? Promise.resolve()).then(go, go)
        return queued
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
