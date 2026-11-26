import { defineDoc } from '@earendil-works/pi-durable'
import type { JsonValue } from '@earendil-works/chord/json'
import { checkpointEvery } from './checkpoint.ts'

export const UiState = defineDoc<Record<string, JsonValue>>({
  kind: 'ultimate.ui',
  checkpointWhen: checkpointEvery(100),
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})

export const UiWriters = defineDoc<Record<string, number>>({
  kind: 'ultimate.ui-writers',
  checkpointWhen: checkpointEvery(100),
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})
