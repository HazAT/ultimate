import type { ConversationId } from '@earendil-works/pi-durable'
import type { ReactNode } from 'react'
import { definePoint } from '@/sdk'

export const PickerRows = definePoint<
  { query: string; conversation: ConversationId | undefined; close: () => void },
  ReactNode
>('models.picker-rows')
