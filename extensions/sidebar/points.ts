import type { ConversationId } from '@earendil-works/pi-durable'
import type { ReactNode } from 'react'
import { definePoint } from '../../web/src/sdk/types.ts'

export const UnderUltimate = definePoint<{ conversation: ConversationId | undefined }, ReactNode>(
  'sidebar.under-ultimate',
)
export const Unlisted = definePoint<ConversationId | undefined, ReadonlySet<number>>(
  'sidebar.unlisted',
)
export const PreviewUp = definePoint<ConversationId | undefined, boolean>('sidebar.preview-up')
