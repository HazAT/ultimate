import type { ConversationId } from '@earendil-works/pi-durable'
import { definePoint } from '../../web/src/sdk/types.ts'

export const ConversationTaskChip = definePoint<
  { conversation: ConversationId; on: string },
  unknown
>('conversations.task-chip')
