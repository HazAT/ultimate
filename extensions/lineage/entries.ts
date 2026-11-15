import { defineEntry } from '@earendil-works/pi-durable'
import type { ConversationId, EntryId } from '@earendil-works/pi-durable'
import type { RewindFile, RewindDependent } from './refs.ts'

/** A branch marker in its source and tally. */
export const BranchedEntry = defineEntry<{
  branch: ConversationId
  at: EntryId
  intent: string
  images?: number
  from?: ConversationId
}>('lineage.branched')

/** The note marking a go-back, including the path the transcript sets aside. */
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

/** A go-back notice in a conversation that built on the old path. */
export const RewoundDependentEntry = defineEntry<{
  from: ConversationId
  at: EntryId
  entry: EntryId
}>('lineage.rewound-dependent')
