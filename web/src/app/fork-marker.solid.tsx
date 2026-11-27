import type { ConversationId, EntryRecord } from '@earendil-works/pi-durable'
import { GitFork } from '@lucide/solid'
import { createMemo, Show } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { events, formatTime, switchConversation, useConversationSummary } from '../sdk/hooks.ts'
import { forkStart } from './fork.ts'

export function ForkMarker(props: { id: ConversationId; entries: readonly EntryRecord[] }) {
  const summary = useConversationSummary(() => props.id)
  const forkOf = () => summary()?.forkOf
  const source = useConversationSummary(() => forkOf()?.conversationId)
  const start = createMemo(() => {
    const fork = forkOf()
    return fork && forkStart(props.entries, props.id, fork.at)
  })
  const name = () => {
    const row = source()
    const id = forkOf()!.conversationId
    if (row?.label === 'agent' && row.title) return row.title
    return row?.title ? `#${id} ${row.title}` : `#${id}`
  }
  const open = () => {
    const fork = forkOf()!
    events.emit('messages:open', { conversation: fork.conversationId, entry: fork.at })
    switchConversation(fork.conversationId)
  }
  return (
    <Show when={start()}>
      {(point) => (
        <div
          class="flex min-w-0 items-center gap-3 font-mono text-[11px] text-muted-foreground"
          data-fork-marker={forkOf()!.conversationId}
          data-ui="transcript-meta"
        >
          <hr class="h-px min-w-4 flex-1 border-0 border-t border-dashed border-border" />
          <span class="flex min-w-0 items-center gap-1.5">
            <GitFork class="size-3 shrink-0 text-brand" />
            <span class="shrink-0">forked from</span>
            <Button
              aria-label={`Open fork source #${forkOf()!.conversationId} at entry ${forkOf()!.at}`}
              class="h-auto min-w-0 truncate rounded-none p-0 font-mono text-[11px] font-normal underline-offset-2 hover:text-foreground hover:underline"
              onClick={open}
              size={null}
              title={`Open #${forkOf()!.conversationId} at entry ${forkOf()!.at}`}
              variant={null}
            >
              {name()}
            </Button>
            <Show when={point().at}>
              {(at) => (
                <span class="shrink-0">
                  <span class="max-sm:hidden">at </span>
                  <span class="sm:hidden">· </span>
                  {formatTime(at())}
                </span>
              )}
            </Show>
            <span class="shrink-0 max-sm:hidden">
              ·{' '}
              {point().fresh
                ? 'starts from a brief, not this history'
                : 'knows everything up to here'}
            </span>
          </span>
          <hr
            aria-hidden="true"
            class="h-px min-w-4 flex-1 border-0 border-t border-dashed border-border"
          />
        </div>
      )}
    </Show>
  )
}
