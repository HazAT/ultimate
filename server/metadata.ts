import { defineDoc } from '@earendil-works/pi-durable'

export const Metadata = defineDoc<{
  title?: string
  label?: string
  inputTitle?: string
  inputAt?: number
  answerAt?: number
}>({
  kind: 'ultimate.metadata',
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})
