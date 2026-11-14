import type { ConversationId, EntryId } from '@earendil-works/pi-durable'
export type AgentOrigin = {
  body: string
  agent: string
  failed?: boolean
  sender: ConversationId
  entry?: EntryId
  kind: 'instruction' | 'report'
}
