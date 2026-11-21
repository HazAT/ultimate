/** @jsxImportSource @solidjs/web */
import { RotateCw } from '@lucide/solid'
import { createMemo, For, Show } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { switchConversation } from '@/sdk/solid'
import type { SolidEntryProps } from '@/sdk/solid'
import { ConversationRef } from '../conversations/ui.solid.tsx'
import type { BuildNote } from './refs.ts'

const short = (id: string) => id.slice(0, 7)
const named = 2

export function Note(props: SolidEntryProps) {
  const note = () => (props.entry.data ?? {}) as BuildNote
  const content = () => props.entry.model?.[0]?.content
  const landed = () => note().landed ?? []
  const parts = createMemo(() => {
    const { from, to, instructions, docs } = note()
    return [
      from && to && !landed().length && `build ${short(from)} → ${short(to)}`,
      instructions?.length && `instructions: ${instructions.join(', ')}`,
      docs?.length && `docs: ${docs.join(', ')}`,
    ]
      .filter(Boolean)
      .join(' · ')
  })
  return (
    <Show when={parts() || landed().length}>
      <div
        class="flex items-center gap-3 font-mono text-[11px] text-muted-foreground/80 before:h-px before:flex-1 before:bg-brand/25 after:h-px after:flex-1 after:bg-brand/25"
        title={typeof content() === 'string' ? (content() as string) : undefined}
      >
        <span class="flex max-w-[85%] min-w-0 items-center gap-1.5">
          <RotateCw class="size-3 shrink-0 text-brand" />
          <span class="shrink-0 text-brand">
            {note().from ? 'Reloaded' : 'Instructions changed'}
          </span>
          <For each={landed().slice(0, named)}>
            {(row) => (
              <span class="flex min-w-0 items-center gap-1.5">
                <span class="shrink-0">·</span>
                <Show
                  when={row.conversation}
                  fallback={
                    <span class="min-w-0 truncate text-foreground/85" title={row.title}>
                      {row.title}
                    </span>
                  }
                >
                  {(id) => (
                    <Button
                      aria-label={`Open #${id()}`}
                      class="flex min-w-0 shrink justify-start overflow-hidden text-[11px] font-normal text-foreground/85 hover:underline"
                      onClick={() => switchConversation(id())}
                      size={null}
                      title={`Open #${id()}`}
                      variant={null}
                    >
                      <ConversationRef id={id()} title={row.title} />
                    </Button>
                  )}
                </Show>
              </span>
            )}
          </For>
          <Show when={landed().length > named}>
            <span class="shrink-0">· +{landed().length - named} more</span>
          </Show>
          <Show when={parts()}>
            <span class="truncate">· {parts()}</span>
          </Show>
        </span>
      </div>
    </Show>
  )
}
