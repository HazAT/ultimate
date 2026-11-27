import { ChevronDown } from '@lucide/solid'
import { For, Show } from 'solid-js'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.solid.tsx'
import { cn, useConversations, useExternal } from '@/sdk/solid'
import { getPreviews, getShown, refetchPreviews, show, subscribe } from './previews.web.ts'
import type { Preview } from './refs.ts'

const port = (url: string) => `:${new URL(url).port}`

export function Switcher() {
  const previews = useExternal(getPreviews, subscribe)
  const shown = useExternal(getShown, subscribe)
  const running = () => previews()?.filter((preview) => preview.running) ?? []
  const current = () => shown()?.preview
  const conversations = useConversations()
  const title = (preview: Preview) =>
    conversations().find((conversation) => conversation.id === preview.conversationId)?.title
  return (
    <Show when={running().length > 0}>
      <DropdownMenu modal={false} onOpenChange={(open) => open && refetchPreviews()}>
        <DropdownMenuTrigger
          aria-label="Switch to a preview"
          class={cn(
            'flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 font-mono text-[11.5px] text-muted-foreground transition-colors outline-none hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring data-open:bg-accent',
            current() && 'bg-brand/10',
          )}
        >
          <Show
            when={current()}
            fallback={
              <span class="max-md:hidden">
                {running().length} {running().length === 1 ? 'preview' : 'previews'}
              </span>
            }
          >
            {(preview) => (
              <>
                <span class="size-1.5 rounded-full bg-brand" />#{preview().conversationId} ·{' '}
                {port(preview().url)}
              </>
            )}
          </Show>
          <ChevronDown class="size-3.5 opacity-60" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" class="w-80">
          <DropdownMenuGroup>
            <DropdownMenuLabel class="px-2 pt-1 pb-1.5 section-label">Instances</DropdownMenuLabel>
            <DropdownMenuItem class="gap-2 py-1.5" onSelect={() => show(undefined)}>
              <span class={cn('flex-1 text-[13px]', !current() && 'text-brand')}>This project</span>
              <span class="font-mono text-[11px] text-muted-foreground">{port(location.href)}</span>
            </DropdownMenuItem>
            <For each={running()} keyed={(preview) => preview.id}>
              {(preview) => (
                <DropdownMenuItem
                  class="gap-2 py-1.5"
                  data-instance={preview().id}
                  label={`#${preview().conversationId} ${title(preview()) ?? ''}`.trim()}
                  onSelect={() => show(preview())}
                >
                  <span
                    class={cn(
                      'min-w-0 flex-1 truncate text-[13px]',
                      current()?.id === preview().id && 'text-brand',
                    )}
                  >
                    #{preview().conversationId}
                    <Show when={title(preview())}>
                      {(name) => <span class="text-muted-foreground"> {name()}</span>}
                    </Show>
                  </span>
                  <span class="shrink-0 font-mono text-[11px] text-muted-foreground">
                    {port(preview().url)}
                  </span>
                </DropdownMenuItem>
              )}
            </For>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </Show>
  )
}
