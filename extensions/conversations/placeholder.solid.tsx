/** @jsxImportSource @solidjs/web */
import type { ConversationId } from '@earendil-works/pi-durable'
import type { Accessor } from 'solid-js'
import { createMemo } from 'solid-js'
import { ROOT, useDocOf } from '@/sdk/solid'
import { StandingDoc } from '../subagents/refs.ts'
import { agentTitle, standingPlaceholder as placeholderText } from './mark-style.ts'
import { MarksDoc } from './refs.ts'

export function standingPlaceholder(
  input: Accessor<{ conversation: ConversationId; busy: boolean }>,
) {
  const standing = useDocOf(() => ROOT, StandingDoc)
  const marks = useDocOf(() => ROOT, MarksDoc)
  return createMemo(() => {
    const { conversation, busy } = input()
    const name = Object.entries(standing() ?? {}).find(([, id]) => id === conversation)?.[0]
    return placeholderText(name, name ? agentTitle(name, marks()).title : '', busy)
  })
}
