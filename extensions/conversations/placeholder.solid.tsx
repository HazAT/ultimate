/** @jsxImportSource @solidjs/web */
import type { ConversationId } from '@earendil-works/pi-durable'
import type { Accessor } from 'solid-js'
import { createMemo } from 'solid-js'
import { ROOT, useDocOf } from '@/sdk/solid'
import { StandingDoc } from '../subagents/refs.ts'
import { agentTitle } from './mark-style.ts'
import { MarksDoc } from './refs.ts'

/** "Message Coach…" in a standing agent's empty composer, other than @ultimate's, while it is idle. */
export function standingPlaceholder(
  input: Accessor<{ conversation: ConversationId; busy: boolean }>,
) {
  const standing = useDocOf(() => ROOT, StandingDoc)
  const marks = useDocOf(() => ROOT, MarksDoc)
  return createMemo(() => {
    const { conversation, busy } = input()
    const name = Object.entries(standing() ?? {}).find(([, id]) => id === conversation)?.[0]
    if (!name || name === 'ultimate' || busy) return undefined
    const { title } = agentTitle(name, marks())
    return title ? `Message ${title}…` : undefined
  })
}
