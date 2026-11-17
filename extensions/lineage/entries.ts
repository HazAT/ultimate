import { defineEntry } from '@earendil-works/pi-durable'
import type { ConversationId, EntryId } from '@earendil-works/pi-durable'
import type { RewindFile, RewindDependent } from './refs.ts'

export const BranchedEntry = defineEntry<{
  branch: ConversationId
  at: EntryId
  intent: string
  images?: number
  from?: ConversationId
}>('lineage.branched')

export const RewoundEntry = defineEntry<{
  at: EntryId
  setAside: EntryId
  steps: number
  files: RewindFile[]
  commits: { sha: string; subject: string }[]
  dependents: RewindDependent[]
  summary?: string
  summaryMissing?: true
}>('lineage.rewound')

export const RewoundDependentEntry = defineEntry<{
  from: ConversationId
  at: EntryId
  entry: EntryId
}>('lineage.rewound-dependent')
