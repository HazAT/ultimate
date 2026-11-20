import type { ConversationId } from '@earendil-works/pi-durable'
import { definePoint } from '../../web/src/sdk/types.ts'

export const UnderUltimate = definePoint<
  { conversation: ConversationId | undefined },
  import('react').ReactNode
>('sidebar.under-ultimate')
export const Unlisted = definePoint<ConversationId | undefined, ReadonlySet<number>>(
  'sidebar.unlisted',
)
export const PreviewUp = definePoint<ConversationId | undefined, boolean>('sidebar.preview-up')
