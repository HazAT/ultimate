import { Brain, Check } from '@lucide/solid'
import { createMemo, Show } from 'solid-js'
import { CommandItem } from '@/components/ui/command.solid.tsx'
import { cn } from '@/sdk/solid'
import { modelFacts, modelKey } from './state.ts'
import type { ModelInfo } from './state.ts'

export function ModelRow(props: {
  model: ModelInfo
  current: boolean
  disabled?: boolean
  compact?: boolean
}) {
  const facts = createMemo(() => modelFacts(props.model))
  return (
    <CommandItem
      class={cn('gap-2 py-1 font-mono text-[12px]', !props.model.available && 'opacity-60')}
      disabled={props.disabled}
      value={modelKey(props.model)}
    >
      <Check class={cn('size-3.5', props.current ? 'text-brand' : 'opacity-0')} />
      <span class={cn('shrink-0', props.current ? 'text-brand' : 'text-foreground')}>
        <span class="sr-only">{props.model.provider}/</span>
        {props.model.id}
      </span>{' '}
      <Show when={props.model.name !== props.model.id}>
        <span class="min-w-0 truncate font-sans text-[12px] text-muted-foreground/80">
          {props.model.name}
        </span>{' '}
      </Show>
      <span
        class="ml-auto flex shrink-0 items-center gap-3 pl-3 text-[11px] text-muted-foreground tabular-nums"
        aria-hidden="true"
      >
        <Show when={!props.compact && facts().paid}>
          <span class="text-warning/80">{facts().paid}</span>
        </Show>
        <span
          class={cn(
            'flex items-center gap-1',
            !facts().thinkingTitle && 'text-muted-foreground/40',
          )}
          title={facts().thinkingTitle}
        >
          {facts().thinkingTitle && <Brain class="size-3" />}
          {facts().thinking}
        </span>
        <Show when={!props.compact}>
          <span class="w-11 text-right" title="context window">
            {facts().context}
          </span>
          <span class="w-20 text-right max-sm:hidden" title="$ per million input / output tokens">
            {facts().cost}
          </span>
        </Show>
      </span>
    </CommandItem>
  )
}
