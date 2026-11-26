import { defineDoc } from '@earendil-works/pi-durable'
import { checkpointEvery } from '../shared/checkpoint.ts'

export const Metadata = defineDoc<{
  title?: string
  label?: string
  external?: string
  inputTitle?: string
  inputAt?: number
  answerAt?: number
}>({
  kind: 'ultimate.metadata',
  checkpointWhen: checkpointEvery(100),
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})
