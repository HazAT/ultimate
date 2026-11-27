import type { JsonValue } from '@earendil-works/chord/json'
import { UI_REVISION } from '../../../shared/protocol.ts'
import { deadline } from '../../../lib/timers.shared.ts'
import type { Cancel } from '../../../lib/timers.shared.ts'
import type { UiUpdateRequest, UiUpdateResponse } from '../../../shared/protocol.ts'
import { writerNow } from './writer.ts'
import type { UiWho } from './writer.ts'

export type UiValues = Readonly<Record<string, JsonValue>>

interface PendingOp {
  key: string
  value: JsonValue | undefined
  who: UiWho
  seq: number
}

interface SentWrite {
  value: JsonValue | undefined
  seq: number
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
  const refusedAppWrites = new Map<string, Set<string>>()
  const refused = (key: string, value: JsonValue | undefined) =>
    refusedAppWrites.get(key)?.has(JSON.stringify(value)) ?? false
  const tabOnly = options.tabOnly ?? (() => false)
  let tabOnlyAtLoad: UiValues | undefined
  const tabOnlyWrites = new Map<string, JsonValue | undefined>()
  let values: UiValues = {}

  const tab = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
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

  const request = (ops: PendingOp[]): UiUpdateRequest => ({
    ops: ops.map(({ key, value, who, seq }) => ({
      key,
      ...(value === undefined ? {} : { value }),
      who,
      seq,
    })),
    tab,
  })
  const fitsKeepalive = (ops: PendingOp[]) =>
    new TextEncoder().encode(JSON.stringify(request(ops))).byteLength <= KEEPALIVE_BYTES

  function send(ops = oldestWriterRun(), exit = false) {
    if (!write || ops.length === 0) return undefined
    const batch = ++lastSentBatch
    for (const { key, value, seq } of ops)
      if ((unconfirmedSentWrites.get(key)?.seq ?? 0) <= seq)
        unconfirmedSentWrites.set(key, { value, seq, batch })
    const sentInServerEpoch = serverProcessEpoch
    const storedAtSend = ops.map(({ key }) => streamSnapshot[key])
    const settled = () => {
      if (inFlight === sent) inFlight = undefined
      if (pending.length > 0) schedule(0)
    }
    const keepalive = exit ? { keepalive: fitsKeepalive(ops) } : undefined
    const done = write(request(ops), ops[0].who, keepalive).then(
      (response) => {
        if (sentInServerEpoch !== serverProcessEpoch) return
        refusedAppWrites.clear()
        for (const entry of unconfirmedSentWrites.values())
          if (entry.batch === batch) entry.rev = response.rev
        settled()
        releaseStreamConfirmedWrites()
        update()
      },
      (error: unknown) => {
        if (sentInServerEpoch !== serverProcessEpoch) return
        ops.forEach(({ key, value, who }, index) => {
          if (who !== 'app' || !same(streamSnapshot[key], storedAtSend[index])) return
          const refusals = refusedAppWrites.get(key) ?? new Set()
          refusedAppWrites.set(key, refusals.add(JSON.stringify(value)))
        })
        const queued = pending.filter((op) => op.who !== 'app' || !refused(op.key, op.value))
        pending.splice(0, pending.length, ...queued)
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
    const who = writerNow()
    if (who !== 'app') refusedAppWrites.delete(key)
    if (same(values[key], value)) return
    if (!write || tabOnly(key)) {
      tabOnlyWrites.set(key, value)
      update()
      return
    }
    if (who === 'app' && refused(key, value)) return
    const newest = pending.at(-1)
    if (newest?.key === key && newest.who === who) newest.value = value
    else pending.push({ key, value, who, seq: ++lastSeq })
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
      for (const key of refusedAppWrites.keys())
        if (!same(next[key], streamSnapshot[key])) refusedAppWrites.delete(key)
      streamSnapshot = next
      tabOnlyAtLoad ??= Object.fromEntries(Object.entries(next).filter(([key]) => tabOnly(key)))
      newestStreamRevision = rev
      awaitingRestartSnapshot = false
      releaseStreamConfirmedWrites()
      update()
    },

    restarted() {
      serverProcessEpoch++
      refusedAppWrites.clear()
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
      const copied = inFlight?.ops ?? []
      const unsent = pending.splice(0)
      const together = [...copied, ...unsent]
      const requests = fitsKeepalive(together) ? [together] : [unsent, copied]
      const sent = requests.flatMap((ops) => send(ops, true) ?? [])
      const all = Promise.all(sent.map((each) => each.done)).then(() => undefined)
      const exiting = { ops: together, done: all }
      inFlight = sent.length ? exiting : undefined
      await all
      if (inFlight === exiting) inFlight = undefined
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
