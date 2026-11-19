import { defineDoc } from '@earendil-works/pi-durable'
import type { JsonValue } from '@earendil-works/chord/json'

export const UiState = defineDoc<Record<string, JsonValue>>({
  kind: 'ultimate.ui',
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'rewindable',
  fork: 'asOf',
  initial: () => ({}),
})

const writerDeltasBetweenBases = 100

export const UiWriters = defineDoc<Record<string, number>>({
  kind: 'ultimate.ui-writers',
  checkpointWhen: (_value, _ops, { deltasSinceBase }) =>
    deltasSinceBase >= writerDeltasBetweenBases,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})
