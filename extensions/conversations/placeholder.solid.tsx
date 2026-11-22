import type { ConversationId } from '@earendil-works/pi-durable'
import type { Accessor } from 'solid-js'
import { createMemo } from 'solid-js'
import { ROOT, useConversations, useDocOf } from '@/sdk/solid'
import { agentTitle, standingPlaceholder as placeholderText } from './mark-style.ts'
import { MarksDoc } from './refs.ts'

export function standingPlaceholder(
  input: Accessor<{ conversation: ConversationId; busy: boolean }>,
) {
  const conversations = useConversations()
  const marks = useDocOf(() => ROOT, MarksDoc)
  return createMemo(() => {
    const { conversation, busy } = input()
    const summary = conversations().find((row) => row.id === conversation)
    const name = summary?.label === 'agent' ? summary.title?.replace(/^@/, '') : undefined
    return placeholderText(name, name ? agentTitle(name, marks()).title : '', busy)
  })
}
