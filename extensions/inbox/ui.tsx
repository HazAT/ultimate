/**
 * Inbox: the point another extension provides to put its own items, things the user has to do, next to the questions
 * waiting on them, and `Waiting`, which renders with both merged.
 */
import type { ReactNode } from 'react'
import { AllProvided, definePoint, useDocOf } from '@/sdk'
import { emptyMessages, MessagesDoc } from '../messages/ui.tsx'
import type { Message } from '../messages/refs.ts'
import { inboxItems } from './items.tsx'
import type { Entry } from './items.tsx'

/** Something that waits on the user, provided by another extension; it leaves when the provider stops listing it. */
export type InboxItem = {
  /** Unique across providers, such as `shell:12`; `?inbox=<key>` and `inbox:open {key}` select it. */
  key: string
  /** When it started waiting, epoch ms: the list is oldest first. */
  at: number
  /** The conversation it belongs to: the row shows it and the reading pane offers "Open in branch". */
  conversation?: number
  /** Where it comes from, drawn where a question's asker goes (another project's tile and name), instead of the conversation. */
  from?: ReactNode
  /** The row's short kind tag, as `question` or `preview` for questions. */
  tag: string
  title: string
  /** One line under the title. */
  gist?: string
  /** The reading pane's content, its buttons included. */
  pane: ReactNode
}

/** Every provider's items; the Inbox, its sidebar row and the To-dos' "For you" count merge them with the questions. */
export const InboxItems = definePoint<null, InboxItem[]>('inbox.items')

/** Renders with everything that waits on the user, oldest first: the open questions and every provided item. */
export function Waiting({
  children,
}: {
  children: (entries: Entry[], messages: readonly Message[]) => ReactNode
}) {
  const { messages } = useDocOf(1, MessagesDoc) ?? emptyMessages
  return (
    <AllProvided input={null} point={InboxItems}>
      {(provided) => children(inboxItems(messages, provided), messages)}
    </AllProvided>
  )
}
