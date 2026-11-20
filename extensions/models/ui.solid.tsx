/** @jsxImportSource @solidjs/web */
/** Model catalog rows for other extensions' Solid command pickers. The Command owns selection and attribution. */
import { Brain, Check } from '@lucide/solid'
import { Show } from 'solid-js'
import { CommandItem } from '@/components/ui/command.solid.tsx'
import { cn } from '@/sdk/solid'
import { formatWindow, modelKey, price } from './state.ts'
import type { ModelInfo } from './state.ts'

export function ModelRow(props: { model: ModelInfo; current: boolean; disabled?: boolean }) {
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
        {props.model.provider === 'anthropic' && <span class="text-warning/80">paid API</span>}
        <Show
          when={props.model.reasoning}
          fallback={<span class="text-muted-foreground/40">no thinking</span>}
        >
          <span
            class="flex items-center gap-1"
            title={`thinking: ${props.model.thinkingLevels.join(' ')}`}
          >
            <Brain class="size-3" />
            {props.model.thinkingLevels.filter((level) => level !== 'off').at(-1)}
          </span>
        </Show>
        <span class="w-11 text-right" title="context window">
          {formatWindow(props.model.contextWindow)}
        </span>
        <span class="w-20 text-right max-sm:hidden" title="$ per million input / output tokens">
          ${price(props.model.cost.input)}/{price(props.model.cost.output)}
        </span>
      </span>
    </CommandItem>
  )
}
