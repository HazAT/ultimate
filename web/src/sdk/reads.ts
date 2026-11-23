import type { ConversationId } from '@earendil-works/pi-durable'
import type { JsonValue } from '@earendil-works/chord/json'
import { actionRef } from '../../../shared/extension-api.ts'
import type { ReadEvent, ReadSpec } from '../../../shared/protocol.ts'
import { ActionError, actionMessage } from './api.ts'
import type { Api } from './api.ts'
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

export function createReads(api: Pick<Api, 'readAction'>, store: Store) {
  const reads = new Map<
    string,
    Read & { readers: Set<Reader>; answered: () => boolean; resetRev: () => void }
  >()
  const changed = new Set<() => void>()
  const inUseReadsSettled = () =>
    store.getState().connection.status !== 'open' ||
    [...reads.values()].every((read) => !read.readers.size || read.answered())
  let connection = store.getState().connection.status
  let connectionGeneration = 0
  store.subscribe(() => {
    const status = store.getState().connection.status
    if (status === connection) return
    if (connection === 'open') {
      connectionGeneration++
      for (const read of reads.values()) read.resetRev()
    }
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
    let used = false
    let readerGeneration = 0
    let lastAnswer: string | undefined
    let lastRev: number | undefined
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
      if (event.rev !== undefined && lastRev !== undefined && event.rev < lastRev) {
        if (state.loading !== fetching) set({ loading: fetching })
        return
      }
      if (event.rev !== undefined) lastRev = event.rev
      const wasAnswered = answered
      answered = true
      const payload =
        'result' in event ? { result: event.result } : { error: event.error, status: event.status }
      const json = JSON.stringify(payload)
      if (json === lastAnswer) {
        if (!wasAnswered || !state.settled || state.loading !== fetching)
          set({ settled: true, loading: fetching })
        return
      }
      lastAnswer = json
      if ('result' in event) {
        set({ data: event.result, error: undefined, settled: true, loading: fetching })
        return
      }
      const failure = new ActionError(extension, name, event.status, event.error, event.rev)
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
      const readersAtStart = readerGeneration
      const connectionAtStart = connectionGeneration
      try {
        fetching = true
        set({ loading: true })
        const { data, event } = await api
          .readAction(actionRef<unknown, unknown>(extension, name), args, { conversationId })
          .then(
            ({ result, rev }) => ({
              data: result,
              event: { result: (result ?? null) as JsonValue, rev },
            }),
            (failure: ActionError) => ({
              data: undefined,
              event:
                failure.status === 0
                  ? undefined
                  : { error: failure.message, status: failure.status, rev: failure.rev },
            }),
          )
        fetching = false
        if (readerGeneration === readersAtStart && connectionGeneration === connectionAtStart) {
          if (event) answer(event, onError)
          else answered = true
        }
        return data
      } finally {
        fetching = false
        if (state.loading) set({ loading: false })
      }
    }
    const read = {
      readers,
      get: () => state,
      answered: () => answered,
      resetRev: () => {
        lastRev = undefined
      },
      subscribe(listener: () => void) {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
      use(reader: Reader) {
        used = true
        reads.delete(key)
        reads.set(key, read)
        readers.add(reader)
        repoll()
        return function releaseReader() {
          readers.delete(reader)
          repoll()
          if (readers.size) return
          readerGeneration++
          answered = false
          lastRev = undefined
          queued = undefined
          evictOldestIdleReads()
          for (const listener of changed) listener()
        }
      },
      refetch() {
        const onError = errorHandler()
        const readersAtQueue = readerGeneration
        const go = () => {
          if (readersAtQueue !== readerGeneration) return undefined
          queued = undefined
          if (used && !readers.size) return undefined
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
