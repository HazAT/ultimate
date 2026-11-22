import { GitMerge } from '@lucide/solid'
import { Show } from 'solid-js'
import { cn, column, ROOT, useConversationId, useDocOf } from '@/sdk/solid'
import type { SolidComposerProps } from '@/sdk/solid'
import { WorkspacesDoc } from './refs.ts'

export function LanderComposer(props: SolidComposerProps) {
  const id = useConversationId()
  const index = useDocOf(() => ROOT, WorkspacesDoc)
  const lander = () => {
    const shown = id()
    const landers = Object.values(index()?.landerConversations ?? {})
    return shown !== undefined && landers.includes(shown) ? shown : undefined
  }
  return (
    <Show when={lander()} fallback={props.core}>
      {(shown) => (
        <div class={cn(column(props.dock), 'pb-3')}>
          <div
            class="flex items-center gap-2.5 rounded-lg border border-border/70 bg-muted/30 px-3.5 py-2.5 text-[12.5px] text-muted-foreground"
            data-lander-log={shown()}
          >
            <GitMerge class="size-4 shrink-0 text-brand" />
            The landing log. The lander is code, not a model: each submission's outcome goes back to
            its branch.
          </div>
        </div>
      )}
    </Show>
  )
}
