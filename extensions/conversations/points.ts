import type { ConversationId } from '@earendil-works/pi-durable'
import type { JSX } from '@solidjs/web'
import { definePoint } from '../../web/src/sdk/types.ts'

export const ConversationPhase = definePoint<
  ConversationId | undefined,
  { word: string; waiting: boolean } | undefined
>('conversations.phase')

export const ConversationTask = definePoint<
  ConversationId | undefined,
  { title: string } | undefined
>('conversations.task')

export const ConversationEpic = definePoint<
  ConversationId,
  { key: string; title: string; status: string; progress?: string; open: () => void } | undefined
>('conversations.epic')

export const Unsummarized = definePoint<ConversationId, boolean>('conversations.unsummarized')

export const ConversationTaskChip = definePoint<
  { conversation: ConversationId; on: string },
  JSX.Element
>('conversations.task-chip')
