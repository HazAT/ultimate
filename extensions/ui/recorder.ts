import type { ConversationId } from '@earendil-works/pi-durable'
import type { JsonValue } from '@earendil-works/chord/json'
import type { ObservedChange } from '@ui-sdk/core/agent'
import { batch } from '../../lib/timers.ts'
import { bounded, MAX_CHANGES, MAX_LABEL, MAX_NAME } from './limits.ts'
import type { UiChange } from './refs.ts'

export type Location = { surface?: string; conversation?: ConversationId }
export type Batch = Location & { changes: UiChange[]; driven?: boolean }

const BATCH_MS = 500

const json = (value: unknown): JsonValue =>
  JSON.parse(JSON.stringify(value ?? null) ?? 'null') as JsonValue

const clipped = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text

const recorded = (change: ObservedChange): UiChange => ({
  component: clipped(change.component, MAX_NAME),
  ...(change.label ? { label: clipped(change.label, MAX_LABEL) } : {}),
  key: clipped(change.key, MAX_NAME),
  value: bounded(json(change.value)),
  ...(change.previous === undefined ? {} : { previous: bounded(json(change.previous)) }),
  source: clipped(change.source, MAX_NAME),
  ...(change.reason ? { reason: clipped(change.reason, MAX_NAME) } : {}),
})

const sameLocation = (a: Location, b: Location) =>
  a.surface === b.surface && a.conversation === b.conversation

export function createRecorder(options: {
  locate: () => Location
  send: (batch: Batch, keepalive: boolean) => Promise<unknown>
  driven: boolean
}) {
  let pending: { where: Location; change: UiChange }[] = []
  function sendPending(keepalive: boolean) {
    const batches: Batch[] = []
    for (const { where, change } of pending) {
      const last = batches.at(-1)
      if (last && sameLocation(last, where) && last.changes.length < MAX_CHANGES)
        last.changes.push(change)
      else
        batches.push({ ...where, changes: [change], ...(options.driven ? { driven: true } : {}) })
    }
    pending = []
    return Promise.all(batches.map((each) => options.send(each, keepalive)))
  }
  const scheduled = batch(BATCH_MS, () => void sendPending(false))
  return {
    observe: (change: ObservedChange) => {
      pending.push({ where: options.locate(), change: recorded(change) })
      scheduled()
    },
    flush: (keepalive: boolean) => {
      scheduled.cancel()
      return sendPending(keepalive)
    },
  }
}
