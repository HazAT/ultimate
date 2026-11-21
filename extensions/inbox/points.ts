import type { ConversationId } from '@earendil-works/pi-durable'
import type { ReactNode } from 'react'
import { definePoint } from '../../web/src/sdk/types.ts'
import type { Message } from '../messages/refs.ts'

export type InboxItem = {
  key: string
  at: number
  conversation?: ConversationId
  tag: string
  title: string
  gist?: string
  pane: ReactNode
}

export const InboxItems = definePoint<null, InboxItem[]>('inbox.items')
export const QuestionPane = definePoint<
  { message: Message | undefined; phone: boolean },
  ReactNode | undefined
>('inbox.question-pane')
