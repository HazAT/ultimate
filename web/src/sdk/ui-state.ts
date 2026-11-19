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
const KEEPALIVE_BYTES = 60 * 1024

export function tabWrites(tab: { driven: boolean; detached: boolean; webdriver: boolean }) {
  const automatedWithoutDrivenFlag = tab.webdriver && !tab.driven
  return {
    shares: !tab.detached && !automatedWithoutDrivenFlag,
    ...(tab.driven ? { tabOnly: movesTheUsersView } : {}),
  }
}

export type UiWrite = (
  change: UiUpdateRequest,
  who: UiWho,
  options?: { keepalive: boolean },
) => Promise<UiUpdateResponse>

export function createUiState(
  write: UiWrite | undefined,
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
  let inFlight: Promise<void> | undefined

  let serverProcessEpoch = 0

  let awaitingRestartSnapshot = false
  let cancelSend: Cancel | undefined
  const unsent = () => [...unconfirmedLocalWrites].filter(([, entry]) => entry.batch === undefined)

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
      inFlight ??= send()
    })
  }

  function send(keepaliveBudget?: { bytes: number }): Promise<void> | undefined {
    const pending = unsent()
    if (!write || pending.length === 0) return undefined
    const change: UiUpdateRequest = { set: {}, delete: [] }
    const batch = ++lastSentBatch
    const who = pending[0][1].who
    for (const [key, entry] of pending) {
      if (entry.who !== who) break
      entry.batch = batch
      if (entry.value === undefined) change.delete?.push(key)
      else if (change.set) change.set[key] = entry.value
    }
    const bytes = new TextEncoder().encode(JSON.stringify(change)).byteLength
    const keepalive = keepaliveBudget !== undefined && bytes <= keepaliveBudget.bytes
    if (keepalive) keepaliveBudget.bytes -= bytes
    const sentInServerEpoch = serverProcessEpoch
    const settled = () => {
      if (inFlight === sent) inFlight = undefined
      if (unsent().length > 0) schedule(0)
    }
    const sent: Promise<void> = write(change, who, keepalive ? { keepalive } : undefined).then(
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
    return sent
  }
  function set(key: string, value: JsonValue | undefined) {
    if (same(values[key], value)) return
    if (tabOnly(key)) {
      tabOnlyWrites.set(key, value)
      update()
      return
    }
    unconfirmedLocalWrites.delete(key)
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
      inFlight = undefined
      awaitingRestartSnapshot = true
      for (const entry of unconfirmedLocalWrites.values())
        if (entry.batch !== undefined) entry.rev = 0
      if (unsent().length > 0) schedule(0)
    },

    async flush({ keepalive = false } = {}) {
      cancelSend?.()
      cancelSend = undefined
      if (!write) return
      if (keepalive) {
        const budget = { bytes: KEEPALIVE_BYTES }
        const leaving = inFlight ? [inFlight] : []
        for (let sent = send(budget); sent; sent = send(budget)) leaving.push(sent)
        await Promise.all(leaving)
        return
      }
      while (inFlight || unsent().length > 0) {
        inFlight ??= send()
        await inFlight
      }
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
