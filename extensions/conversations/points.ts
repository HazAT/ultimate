import type { ConversationId } from '@earendil-works/pi-durable'
import { definePoint } from '../../web/src/sdk/types.ts'

export const Unsummarized = definePoint<ConversationId, boolean>('conversations.unsummarized')

export const ConversationTaskChip = definePoint<
  { conversation: ConversationId; on: string },
  unknown
>('conversations.task-chip')
