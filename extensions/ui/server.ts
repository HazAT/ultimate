import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { parseConversationId } from '../../lib/ids.ts'
import { implementAction } from '../../lib/actions.ts'
import { bounded, MAX_CHANGES, MAX_LABEL, MAX_NAME } from './limits.ts'
import { ChangedEvent, RecordAction } from './refs.ts'
import type { UiChange } from './refs.ts'

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

function name(value: unknown, field: string, max = MAX_NAME) {
  if (typeof value !== 'string' || !value || value.length > max)
    throw new Error(`Expected ${field} to be a string of 1–${max} characters`)
  return value
}

function change(value: unknown): UiChange {
  const fields = record(value)
  const { component, label, key, source, reason } = fields
  if (!Object.hasOwn(fields, 'value') || fields.value === undefined)
    throw new Error('Expected value (null for none)')
  return {
    component: name(component, 'component'),
    ...(label === undefined ? {} : { label: name(label, 'label', MAX_LABEL) }),
    key: name(key, 'key'),
    value: bounded(fields.value),
    ...(fields.previous === undefined ? {} : { previous: bounded(fields.previous) }),
    source: name(source, 'source'),
    ...(reason === undefined ? {} : { reason: name(reason, 'reason') }),
  }
}

export const userActions = ['record']

export const actions = {
  record: implementAction(RecordAction, async (args, { host, device }) => {
    const { changes, surface, conversation, driven } = record(args)
    if (!Array.isArray(changes) || changes.length === 0 || changes.length > MAX_CHANGES)
      throw new Error(`Expected { changes } with 1–${MAX_CHANGES} changes`)
    if (conversation !== undefined && !Number.isSafeInteger(conversation))
      throw new Error('Expected conversation to be an integer')
    if (driven !== undefined && typeof driven !== 'boolean')
      throw new Error('Expected driven to be a boolean')
    const where = {
      ...(surface === undefined ? {} : { surface: name(surface, 'surface') }),
      ...(conversation === undefined
        ? {}
        : { conversation: parseConversationId(Number(conversation)) }),
      ...(driven ? { driven: true as const } : {}),
      ...device,
    }
    const events = changes.map((item) => ({ ...change(item), ...where }))
    await host.harness().commit(async function recordUiChanges(tx) {
      for (const data of events) await host.emit(tx, ChangedEvent, data)
    }, BACKGROUND_CONTEXT)
    return { recorded: events.length }
  }),
}

export default { name: 'ui' }
