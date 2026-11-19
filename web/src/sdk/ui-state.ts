import type { JsonValue } from '@earendil-works/chord/json'
import { UI_REVISION } from '../../../shared/protocol.ts'
import { deadline } from '../../../lib/timers.ts'
import type { Cancel } from '../../../lib/timers.ts'
import type { UiUpdateRequest, UiUpdateResponse } from '../../../shared/protocol.ts'
import { writerNow } from './writer.ts'
import type { UiWho } from './writer.ts'

export type UiValues = Readonly<Record<string, JsonValue>>

interface LocalWrite {
  value: JsonValue | undefined
  who: UiWho
  batch?: number
  rev?: number
}

const same = (a: JsonValue | undefined, b: JsonValue | undefined) =>
  JSON.stringify(a) === JSON.stringify(b)
const revision = (values: UiValues) => {
  const rev = values[UI_REVISION]
  return typeof rev === 'number' ? rev : 0
}

const movesTheUsersView = (key: string) => key.startsWith('shell.')

export function tabWrites(tab: { driven: boolean; detached: boolean; webdriver: boolean }) {
  const automatedWithoutDrivenFlag = tab.webdriver && !tab.driven
  return {
    shares: !tab.detached && !automatedWithoutDrivenFlag,
    ...(tab.driven ? { tabOnly: movesTheUsersView } : {}),
  }
}

export function createUiState(
  write: ((change: UiUpdateRequest, who: UiWho) => Promise<UiUpdateResponse>) | undefined,
  options: {
    delayMs?: number
    onError?: (error: unknown) => void
    tabOnly?: (key: string) => boolean
  } = {},
) {
  const listeners = new Set<() => void>()
  let streamSnapshot: UiValues = {}
  const unconfirmedLocalWrites = new Map<string, LocalWrite>()
  const tabOnly = options.tabOnly ?? (() => false)
  let tabOnlyAtLoad: UiValues | undefined
  const tabOnlyWrites = new Map<string, JsonValue | undefined>()
  let values: UiValues = {}

  let lastSentBatch = 0
  let newestStreamRevision = 0
  let batchInFlight = false

  let serverProcessEpoch = 0

  let awaitingRestartSnapshot = false
  let cancelSend: Cancel | undefined
  const writing = new Set<Promise<unknown>>()

  function update() {
    const next: Record<string, JsonValue> = { ...streamSnapshot }
    if (options.tabOnly) {
      for (const key of Object.keys(next)) if (tabOnly(key)) delete next[key]
      Object.assign(next, tabOnlyAtLoad)
    }
    for (const [key, value] of tabOnlyWrites) {
      if (value === undefined) delete next[key]
      else next[key] = value
    }
    for (const [key, { value }] of unconfirmedLocalWrites) {
      if (value === undefined) delete next[key]
      else next[key] = value
    }
    values = next
    for (const listener of listeners) listener()
  }

  function releaseStreamConfirmedWrites() {
    if (awaitingRestartSnapshot) return
    for (const [key, entry] of unconfirmedLocalWrites)
      if (entry.rev !== undefined && entry.rev <= newestStreamRevision)
        unconfirmedLocalWrites.delete(key)
  }
  function schedule(delay: number) {
    cancelSend ??= deadline(delay, () => {
      cancelSend = undefined
      send(false)
    })
  }

  function send(allowConcurrentBatchOnPageExit: boolean) {
    if (!write || (batchInFlight && !allowConcurrentBatchOnPageExit)) return false
    const change: UiUpdateRequest = { set: {}, delete: [] }
    const batch = lastSentBatch + 1
    const who = [...unconfirmedLocalWrites.values()].find((entry) => entry.batch === undefined)?.who
    if (!who) return false
    for (const [, entry] of unconfirmedLocalWrites)
      if (entry.batch === undefined && entry.who === who) entry.batch = batch
    for (const [key, entry] of unconfirmedLocalWrites) {
      if (entry.batch !== batch) continue
      if (entry.value === undefined) change.delete?.push(key)
      else if (change.set) change.set[key] = entry.value
    }
    lastSentBatch = batch
    batchInFlight = true
    const sentInServerEpoch = serverProcessEpoch
    const settled = () => {
      batchInFlight = false
      if ([...unconfirmedLocalWrites.values()].some((entry) => entry.batch === undefined))
        schedule(0)
    }
    const sent = write(change, who).then(
      ({ rev }) => {
        if (sentInServerEpoch !== serverProcessEpoch) return
        for (const entry of unconfirmedLocalWrites.values())
          if (entry.batch === batch) entry.rev = rev
        settled()
        releaseStreamConfirmedWrites()
        update()
      },
      (error: unknown) => {
        if (sentInServerEpoch !== serverProcessEpoch) return
        for (const [key, entry] of unconfirmedLocalWrites)
          if (entry.batch === batch) unconfirmedLocalWrites.delete(key)
        settled()
        update()
        options.onError?.(error)
      },
    )
    writing.add(sent)
    void sent.finally(() => writing.delete(sent))
    return true
  }
  function set(key: string, value: JsonValue | undefined) {
    if (same(values[key], value)) return
    if (tabOnly(key)) {
      tabOnlyWrites.set(key, value)
      update()
      return
    }
    unconfirmedLocalWrites.set(key, { value, who: writerNow() })
    schedule(options.delayMs ?? 150)
    update()
  }

  return {
    get: (key: string): JsonValue | undefined => values[key],
    snapshot: (): UiValues => values,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    set: (key: string, value: JsonValue) => set(key, value),
    delete: (key: string) => set(key, undefined),

    receive(next: UiValues) {
      if (next === streamSnapshot) return
      const rev = revision(next)
      if (rev < newestStreamRevision) return
      streamSnapshot = next
      tabOnlyAtLoad ??= Object.fromEntries(Object.entries(next).filter(([key]) => tabOnly(key)))
      newestStreamRevision = rev
      awaitingRestartSnapshot = false
      releaseStreamConfirmedWrites()
      update()
    },

    restarted() {
      serverProcessEpoch++
      newestStreamRevision = 0
      batchInFlight = false
      awaitingRestartSnapshot = true
      for (const entry of unconfirmedLocalWrites.values())
        if (entry.batch !== undefined) entry.rev = 0
      if ([...unconfirmedLocalWrites.values()].some((entry) => entry.batch === undefined))
        schedule(0)
    },

    flush: () => {
      cancelSend?.()
      cancelSend = undefined
      while (send(true));
      return Promise.all(writing).then(() => undefined)
    },
  }
}
export type UiState = ReturnType<typeof createUiState>

export type Widen<T> = T extends boolean
  ? boolean
  : T extends string
    ? string
    : T extends number
      ? number
      : T
export type UiUpdate<T> = Widen<T> | ((previous: Widen<T>) => Widen<T>)

export function writeUiState<T extends JsonValue>(
  state: UiState,
  key: string,
  initial: T,
  next: UiUpdate<T>,
) {
  const previous = (state.get(key) ?? initial) as Widen<T>
  state.set(key, typeof next === 'function' ? next(previous) : next)
}

export function extensionUiKey(extension: string | null | undefined, key: string) {
  if (!extension) throw new Error('useExtensionUiState works inside an extension contribution only')
  return `ext.${extension}.${key}`
}
