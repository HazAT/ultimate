import type { JsonValue } from '@earendil-works/chord/json'
import { UI_REVISION } from '../../../shared/protocol.ts'
import { deadline } from '../../../lib/timers.ts'
import type { Cancel } from '../../../lib/timers.ts'
import type { UiUpdateRequest, UiUpdateResponse } from '../../../shared/protocol.ts'

export type UiValues = Readonly<Record<string, JsonValue>>

interface LocalWrite {
  value: JsonValue | undefined
  batch?: number
  rev?: number
}

const same = (a: JsonValue | undefined, b: JsonValue | undefined) =>
  JSON.stringify(a) === JSON.stringify(b)
const revision = (values: UiValues) => {
  const rev = values[UI_REVISION]
  return typeof rev === 'number' ? rev : 0
}

export function createUiState(
  write: ((change: UiUpdateRequest) => Promise<UiUpdateResponse>) | undefined,
  options: { delayMs?: number; onError?: (error: unknown) => void } = {},
) {
  const listeners = new Set<() => void>()
  let streamSnapshot: UiValues = {}
  const unconfirmedLocalWrites = new Map<string, LocalWrite>()
  let values: UiValues = {}

  let lastSentBatch = 0
  let newestStreamRevision = 0
  let batchInFlight = false

  let serverProcessEpoch = 0

  let awaitingRestartSnapshot = false
  let cancelSend: Cancel | undefined

  function update() {
    const next: Record<string, JsonValue> = { ...streamSnapshot }
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
    if (!write || (batchInFlight && !allowConcurrentBatchOnPageExit)) return
    const change: UiUpdateRequest = { set: {}, delete: [] }
    const batch = lastSentBatch + 1
    let count = 0
    for (const [, entry] of unconfirmedLocalWrites) {
      if (entry.batch !== undefined) continue
      entry.batch = batch
      count++
    }
    if (count === 0) return
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
    write(change).then(
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
  }
  function set(key: string, value: JsonValue | undefined) {
    if (same(values[key], value)) return
    unconfirmedLocalWrites.set(key, { value })
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
      send(true)
    },
  }
}
export type UiState = ReturnType<typeof createUiState>
