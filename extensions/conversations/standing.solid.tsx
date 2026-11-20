/** @jsxImportSource @solidjs/web */
import type { ConversationId } from '@earendil-works/pi-durable'
import type { JSX } from '@solidjs/web'
import { Show } from 'solid-js'
import { useConversationSummary } from '@/sdk/solid'
import { AgentMark, AgentTitle } from './ui.solid.tsx'

export function StandingEmpty(props: { conversation: ConversationId; core: JSX.Element }) {
  const summary = useConversationSummary(() => props.conversation)
  const standing = () => {
    const current = summary()
    const name = current?.label === 'agent' ? current.title?.replace(/^@/, '') : undefined
    return name && name !== 'ultimate' ? name : undefined
  }
  return (
    <Show when={standing()} fallback={props.core}>
      {(name) => (
        <div class="flex size-full min-h-[55vh] flex-col items-center justify-center gap-3 p-8 text-center">
          <div class="flex flex-col items-center gap-2" data-ui="empty-state">
            <AgentMark name={name()} size="lg" />
            <div class="mt-1 text-[15px] font-semibold text-foreground">
              <AgentTitle name={name()} />
            </div>
            <div class="font-mono text-[11px] text-muted-foreground/70">@{name()}</div>
          </div>
        </div>
      )}
    </Show>
  )
}
