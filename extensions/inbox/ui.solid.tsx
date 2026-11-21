/** @jsxImportSource @solidjs/web */
/** Inbox for Solid: the open questions and waiting items. */
import { createMemo } from 'solid-js'
import { useAllProvided } from '@/sdk/parts.solid.tsx'
import { ROOT, useDocOf } from '@/sdk/solid'
import { MessagesDoc } from '../messages/refs.ts'
import { emptyMessages } from '../messages/ui.solid.tsx'
import { inboxItems } from './items.ts'
import { InboxItems } from './points.ts'

/**
 * Everything that waits on the user, oldest first: open questions and other extensions' items. `failures` holds the
 * inline error card of each provider that throws.
 */
export function Waiting() {
  const log = useDocOf(() => ROOT, MessagesDoc)
  const failures = (<span class="contents" />) as HTMLElement
  const provided = useAllProvided(InboxItems, () => null, failures)
  const messages = () => (log() ?? emptyMessages).messages
  const entries = createMemo(() => inboxItems(messages(), provided()))
  return { entries, messages, failures }
}
