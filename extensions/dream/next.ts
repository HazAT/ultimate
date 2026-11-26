import { defineDoc } from '@earendil-works/pi-durable'
import { checkpointEvery } from '../../shared/checkpoint.ts'
import { DreamDoc } from './refs.ts'
import type { Ask, Dream, Prepared, Sleep } from './refs.ts'

export const Next = defineDoc<{ prepared?: Prepared; sleep?: Sleep; dream?: Dream; ask?: Ask }>({
  kind: DreamDoc.kind,
  checkpointWhen: checkpointEvery(100),
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})
