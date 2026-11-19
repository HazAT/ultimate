import type { ConversationId } from '@earendil-works/pi-durable'
import type { JsonValue } from '@earendil-works/chord/json'
import type { ObservedChange } from '@ui-sdk/core/agent'
import { elementOf } from '@ui-sdk/core/observe'
import { batch } from '../../lib/timers.ts'
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
  'menubar',
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
    const sends = batches.map((each) => options.send(each, keepalive))
    for (const send of sends) {
      const settled: Promise<unknown> = send.then(
        () => inFlight.delete(settled),
        () => inFlight.delete(settled),
      )
      inFlight.add(settled)
    }
    return Promise.all(sends)
  }
  const scheduled = batch(BATCH_MS, () => void sendPending(false))
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
      const earlier = [...inFlight]
      const now = sendPending(keepalive)
      return Promise.allSettled([now, ...earlier]).then(() => now)
    },
  }
}
