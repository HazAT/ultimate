/** @jsxImportSource @solidjs/web */
import { Show } from 'solid-js'
import { ROOT, useConversationId, useDocOf } from '@/sdk/solid'
import type { SolidEntryProps } from '@/sdk/solid'
import { StandingDoc } from '../subagents/refs.ts'

export function QuietAgentRow(props: SolidEntryProps) {
  const id = useConversationId()
  const standing = useDocOf(() => ROOT, StandingDoc)
  return (
    <Show fallback={props.core} when={id() !== undefined && id() === standing()?.voice}>
      <div class="text-xs text-muted-foreground opacity-60">{props.core}</div>
    </Show>
  )
}
