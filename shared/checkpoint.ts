import type { CheckpointInfo } from '@earendil-works/pi-durable'

export const checkpointEvery =
  (deltas: number) =>
  (_value: unknown, _ops: unknown, { deltasSinceBase }: CheckpointInfo) =>
    deltasSinceBase >= deltas
