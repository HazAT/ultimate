/** @jsxImportSource @solidjs/web */
/** Inbox for Solid: the open questions and waiting items. */
import { createMemo } from 'solid-js'
import { useAllProvided, ROOT, useDocOf } from '@/sdk/solid'
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
/** Every provider's waiting items, merged in the Inbox and its counters in waiting order. */
export { InboxItems } from './points.ts'
/** A pane to show instead of the focused question, or undefined to keep the Inbox's own pane. */
export { QuestionPane } from './points.ts'
/**
 * A waiting item, whose unique key selects it from `?inbox=<key>` or `inbox:open { key }`; `at` is when it started
 * waiting, in epoch milliseconds, and orders the list oldest first.
 */
export type { InboxItem } from './points.ts'
