import type { ConversationId } from '@earendil-works/pi-durable'
import type { JsonValue } from '@earendil-works/chord/json'
import type { ObservedChange } from '@ui-sdk/core/agent'
import { elementOf } from '@ui-sdk/core/observe'
import { batch } from '../../lib/timers.ts'
import { inProcess, meansNone } from '../../lib/errors.ts'
import { bounded, MAX_CHANGES, MAX_LABEL, MAX_NAME } from './limits.ts'
import type { UiChange } from './refs.ts'

export type Location = { surface?: string; conversation?: ConversationId }
export type Batch = Location & { changes: UiChange[]; driven?: boolean }

const BATCH_MS = 500
const TEXT_COMPONENTS = new Set(['input', 'textarea'])
const CHOICE_COMPONENTS = new Set([
  'accordion',
  'checkbox-group',
  'listbox',
  'menu',
  'navigation-menu',
  'radio',
  'segmented-control',
  'select',
  'tabs',
  'tree',
])
const REDACTED = '[redacted]'
const WITHHELD = '[value]'

const json = (value: unknown): JsonValue =>
  JSON.parse(JSON.stringify(value ?? null) ?? 'null') as JsonValue

const clipped = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text

const isText = (change: ObservedChange) =>
  typeof change.value === 'string' &&
  (TEXT_COMPONENTS.has(change.component) || change.reason === 'input-change')

const chosenOption = (value: unknown) =>
  typeof value === 'string' ||
  value === null ||
  (Array.isArray(value) && value.every((item) => typeof item === 'string'))

function shown(change: ObservedChange, value: unknown): JsonValue {
  if (value === REDACTED) return REDACTED
  if (typeof value === 'boolean' || typeof value === 'number' || value === undefined)
    return json(value)
  const optionOfAChoiceControl =
    change.key === 'value' && CHOICE_COMPONENTS.has(change.component) && chosenOption(value)
  return optionOfAChoiceControl ? bounded(json(value)) : WITHHELD
}

const recorded = (change: ObservedChange): UiChange => ({
  component: clipped(change.component, MAX_NAME),
  ...(change.label ? { label: clipped(change.label, MAX_LABEL) } : {}),
  key: clipped(change.key, MAX_NAME),
  value: shown(change, change.value),
  ...(change.previous === undefined ? {} : { previous: shown(change, change.previous) }),
  source: clipped(change.source, MAX_NAME),
  ...(change.reason ? { reason: clipped(change.reason, MAX_NAME) } : {}),
})

const sameLocation = (a: Location, b: Location) =>
  a.surface === b.surface && a.conversation === b.conversation

export function createRecorder(options: {
  locate: (element: HTMLElement | undefined) => Location
  send: (batch: Batch, keepalive: boolean) => Promise<unknown>
  driven: boolean
}) {
  let pending: { where: Location; change: UiChange }[] = []
  const inFlight = new Set<Promise<unknown>>()
  const typing = new Map<string, { where: Location; change: UiChange }>()
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
    for (const each of batches) {
      const send = Promise.resolve().then(() => options.send(each, keepalive))
      inFlight.add(send)
      inProcess(
        'a page forgets what it has not sent when it goes, and flush waits for this',
        send.finally(() => inFlight.delete(send)).catch(meansNone),
      )
    }
  }
  const settleInFlight = async () => {
    const results = await Promise.allSettled(inFlight)
    const failed = results.find((result) => result.status === 'rejected')
    if (failed) throw failed.reason
  }
  const scheduled = batch(BATCH_MS, () => {
    sendPending(false)
    inProcess(
      'a batch the timer sent belongs to this page; its failure surfaces like any unawaited action',
      settleInFlight(),
    )
  })
  function queue(entry: { where: Location; change: UiChange }) {
    pending.push(entry)
    scheduled()
  }
  return {
    observe: (change: ObservedChange) => {
      const element = elementOf(change.ref) as HTMLElement | undefined
      const entry = { where: options.locate(element), change: recorded(change) }
      const personTyping = isText(change) && change.source !== 'agent'
      if (!personTyping) return queue(entry)
      if (!typing.has(change.id))
        element?.addEventListener(
          'change',
          () => {
            const edit = typing.get(change.id)
            typing.delete(change.id)
            if (edit) queue(edit)
          },
          { once: true },
        )
      typing.set(change.id, entry)
    },
    flush: (keepalive: boolean) => {
      scheduled.cancel()
      sendPending(keepalive)
      return settleInFlight()
    },
  }
}
