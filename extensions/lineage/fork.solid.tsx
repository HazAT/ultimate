import { GitFork } from '@lucide/solid'
import { createMemo, Show, useContext } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import {
  ConversationScope,
  events,
  formatTime,
  showSurface,
  switchConversation,
  useConversationId,
  useConversationSummary,
  useTranscript,
} from '@/sdk/solid'
import { AgentMark, ConversationRef } from '../conversations/ui.solid.tsx'
import { forkStart } from './fork.web.ts'
import { useRoots } from './ui.solid.tsx'

export function ForkMarker() {
  const id = useConversationId()
  const entries = useTranscript()
  const summary = useConversationSummary(id)
  const forkOf = () => summary()?.forkOf
  const source = useConversationSummary(() => forkOf()?.conversationId)
  const roots = useRoots()
  const scoped = useContext(ConversationScope) !== null
  const start = createMemo(() => {
    const fork = forkOf()
    const own = id()
    return fork && own !== undefined ? forkStart(entries(), own, fork.at) : undefined
  })
  const standing = () =>
    source()?.label === 'agent' ? source()?.title?.replace(/^@/, '') : undefined
  const root = () => roots()?.includes(forkOf()!.conversationId) === true
  const role = () => (root() ? 'project history' : standing() ? undefined : source()?.label)
  const open = () => {
    const fork = forkOf()!
    const { entry, call } = start()!.reveal
    showSurface('agent')
    switchConversation(fork.conversationId)
    events.emit('messages:open', {
      conversation: fork.conversationId,
      entry,
      ...(call ? { call } : {}),
    })
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
              aria-label={`Open fork source #${forkOf()!.conversationId} of #${id()}${scoped ? ' (docked)' : ''}`}
              class="flex h-auto min-w-0 items-center gap-1.5 rounded-none p-0 font-mono text-[11px] font-normal text-foreground/80 hover:text-foreground"
              onClick={open}
              size={null}
              title={`Open #${forkOf()!.conversationId} at entry ${forkOf()!.at}`}
              variant={null}
            >
              <Show when={standing()}>{(name) => <AgentMark name={name()} size="xs" />}</Show>
              <Show when={role()}>
                {(label) => (
                  <span class="shrink-0 text-muted-foreground max-sm:hidden">{label()}</span>
                )}
              </Show>
              <Show
                when={!root()}
                fallback={
                  <span class="shrink-0 text-muted-foreground/70">#{forkOf()!.conversationId}</span>
                }
              >
                <ConversationRef class="gap-1" id={forkOf()!.conversationId} />
              </Show>
            </Button>
            <Show when={point().at}>
              {(at) => <span class="shrink-0">· {formatTime(at())}</span>}
            </Show>
            <span class="shrink-0 max-sm:hidden">
              · {point().fresh ? 'starts from the memory brief' : 'knows everything up to here'}
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
