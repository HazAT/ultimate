import type { ConversationId, EntryId } from '@earendil-works/pi-durable'
export type RootEvent = {
  entry: EntryId
  at?: number
} & (
  | {
      type: 'landed'
      sha: string
      base?: string
      commits: number
      feature?: string
      title?: string
      from?: ConversationId
      compare?: string
    }
  | { type: 'note'; from?: ConversationId; text: string }
  | { type: 'branched'; branch: ConversationId; intent: string }
  | { type: 'compacted' }
  | { type: 'started' }
)
