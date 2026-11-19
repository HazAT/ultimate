import type { JsonValue } from '@earendil-works/chord/json'
import { createAgent } from '@ui-sdk/solid/agent'
import type { ObservedChange } from '@ui-sdk/solid/agent'
import { actionRef } from '../../../shared/extension-api.ts'
import { batch } from '../../../lib/timers.ts'
import type { Api } from './api.ts'
import type { Store } from './store.ts'

export type UiAgent = ReturnType<typeof createAgent>

type RecordedChange = {
  component: string
  label?: string
  key: string
  value: JsonValue
  previous?: JsonValue
  source: string
  reason?: string
}

const RecordAction = actionRef<
  { changes: RecordedChange[]; surface?: string; conversation?: number; driven?: boolean },
  { recorded: number }
>('ui', 'record')

const RECORD_BATCH_MS = 500
const RECORD_BATCH_LIMIT = 50

const json = (value: unknown): JsonValue =>
  JSON.parse(JSON.stringify(value ?? null) ?? 'null') as JsonValue

const recorded = (change: ObservedChange): RecordedChange => ({
  component: change.component,
  ...(change.label ? { label: change.label } : {}),
  key: change.key,
  value: json(change.value),
  ...(change.previous === undefined ? {} : { previous: json(change.previous) }),
  source: change.source,
  ...(change.reason ? { reason: change.reason } : {}),
})

export function createUiAgent(store: Store, api: Api, driven: boolean) {
  let bridge: UiAgent | undefined
  let pending: RecordedChange[] = []

  function send(keepalive: boolean) {
    const { ui, view, system } = store.getState()
    const recorderEnabled = system?.extensions.some(
      (extension) => extension.name === 'ui' && extension.enabled && extension.facets.server,
    )
    const batches = recorderEnabled ? Math.ceil(pending.length / RECORD_BATCH_LIMIT) : 0
    for (let index = 0; index < batches; index++)
      void api.action(
        RecordAction,
        {
          changes: pending.slice(index * RECORD_BATCH_LIMIT, (index + 1) * RECORD_BATCH_LIMIT),
          ...(ui.surface ? { surface: ui.surface.id } : {}),
          ...(view ? { conversation: view.conversation.id } : {}),
          ...(driven ? { driven } : {}),
        },
        { keepalive, conversationId: view?.conversation.id },
      )
    pending = []
  }
  const scheduled = batch(RECORD_BATCH_MS, () => send(false))

  return {
    bridge: () => {
      if (bridge) return bridge
      bridge = createAgent()
      bridge.subscribe((change) => {
        pending.push(recorded(change))
        scheduled()
      })
      return bridge
    },
    flush: () => {
      scheduled.cancel()
      send(true)
    },
  }
}
