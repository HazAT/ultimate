import { defineDoc } from '@earendil-works/pi-durable'
import { AcpSessionDoc } from '../shared/acp.ts'
import type { AcpSession } from '../shared/acp.ts'

export const AcpSessionState = defineDoc<Partial<AcpSession>>({
  kind: AcpSessionDoc.kind,
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})
