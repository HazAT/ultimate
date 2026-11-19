import type { JsonValue } from '@earendil-works/chord/json'
import { UI_REVISION } from '../../../shared/protocol.ts'
import { deadline } from '../../../lib/timers.ts'
import type { Cancel } from '../../../lib/timers.ts'
import type { UiUpdateRequest, UiUpdateResponse } from '../../../shared/protocol.ts'
import { writerNow } from './writer.ts'
import type { UiWho } from './writer.ts'

export type UiValues = Readonly<Record<string, JsonValue>>

interface PendingOp {
  key: string
  value: JsonValue | undefined
  who: UiWho
}

interface SentWrite {
  value: JsonValue | undefined
  batch: number
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
  const pending: PendingOp[] = []
  const unconfirmedSentWrites = new Map<string, SentWrite>()
  const tabOnly = options.tabOnly ?? (() => false)
  let tabOnlyAtLoad: UiValues | undefined
  const tabOnlyWrites = new Map<string, JsonValue | undefined>()
  let values: UiValues = {}

  const tab = crypto.randomUUID()
  let lastSeq = 0
  let lastSentBatch = 0
  let newestStreamRevision = 0
  let inFlight: { ops: PendingOp[]; done: Promise<void> } | undefined

  let serverProcessEpoch = 0

  let awaitingRestartSnapshot = false
  let cancelSend: Cancel | undefined

  function update() {
    const next: Record<string, JsonValue> = { ...streamSnapshot }
    if (options.tabOnly) {
      for (const key of Object.keys(next)) if (tabOnly(key)) delete next[key]
      Object.assign(next, tabOnlyAtLoad)
    }
    const overlay = [
      ...tabOnlyWrites,
      ...[...unconfirmedSentWrites].map(([key, { value }]) => [key, value] as const),
      ...pending.map(({ key, value }) => [key, value] as const),
    ]
    for (const [key, value] of overlay) {
      if (value === undefined) delete next[key]
      else next[key] = value
    }
    values = next
    for (const listener of listeners) listener()
  }

  function releaseStreamConfirmedWrites() {
    if (awaitingRestartSnapshot) return
    for (const [key, entry] of unconfirmedSentWrites)
      if (entry.rev !== undefined && entry.rev <= newestStreamRevision)
        unconfirmedSentWrites.delete(key)
  }
  function schedule(delay: number) {
    cancelSend ??= deadline(delay, () => {
      cancelSend = undefined
      inFlight ??= send()
    })
  }

  function oldestWriterRun() {
    const end = pending.findIndex((op) => op.who !== pending[0].who)
    return pending.splice(0, end === -1 ? pending.length : end)
  }

  function send(ops = oldestWriterRun(), exit = false) {
    if (!write || ops.length === 0) return undefined
    const batch = ++lastSentBatch
    for (const { key, value } of ops) unconfirmedSentWrites.set(key, { value, batch })
    const change: UiUpdateRequest = {
      ops: ops.map(({ key, value, who }) => ({
        key,
        ...(value === undefined ? {} : { value }),
        who,
      })),
      tab,
      seq: ++lastSeq,
    }
    const fitsKeepalive =
      new TextEncoder().encode(JSON.stringify(change)).byteLength <= KEEPALIVE_BYTES
    const sentInServerEpoch = serverProcessEpoch
    const settled = () => {
      if (inFlight === sent) inFlight = undefined
      if (pending.length > 0) schedule(0)
    }
    const done = write(change, ops[0].who, exit ? { keepalive: fitsKeepalive } : undefined).then(
      (response) => {
        if (sentInServerEpoch !== serverProcessEpoch) return
        for (const [key, entry] of unconfirmedSentWrites)
          if (entry.batch !== batch) continue
          else if (response.ok) entry.rev = response.rev
          else unconfirmedSentWrites.delete(key)
        settled()
        releaseStreamConfirmedWrites()
        update()
      },
      (error: unknown) => {
        if (sentInServerEpoch !== serverProcessEpoch) return
        for (const [key, entry] of unconfirmedSentWrites)
          if (entry.batch === batch) unconfirmedSentWrites.delete(key)
        settled()
        update()
        options.onError?.(error)
      },
    )
    const sent = { ops, done }
    return sent
  }
  function set(key: string, value: JsonValue | undefined) {
    if (same(values[key], value)) return
    if (!write || tabOnly(key)) {
      tabOnlyWrites.set(key, value)
      update()
      return
    }
    const who = writerNow()
    const newest = pending.at(-1)
    if (newest?.key === key && newest.who === who) newest.value = value
    else pending.push({ key, value, who })
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
      for (const entry of unconfirmedSentWrites.values()) entry.rev = 0
      if (pending.length > 0) schedule(0)
    },

    async flush() {
      cancelSend?.()
      cancelSend = undefined
      if (!write) return
      while (inFlight || pending.length > 0) {
        inFlight ??= send()
        await inFlight?.done
      }
    },

    async exit() {
      cancelSend?.()
      cancelSend = undefined
      const ops = [...(inFlight?.ops ?? []), ...pending.splice(0)]
      inFlight = send(ops, true)
      await inFlight?.done
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
