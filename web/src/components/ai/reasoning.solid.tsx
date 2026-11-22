import { ChevronRight } from '@lucide/solid'
import { cn } from 'cn'
import { omit, Show } from 'solid-js'
import type { ComponentProps } from 'solid-js'
import { Markdown } from '@/components/markdown/markdown.solid.tsx'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible.solid.tsx'
import { Shimmer } from './shimmer.solid.tsx'

export type ReasoningProps = Omit<ComponentProps<typeof Collapsible>, 'children' | 'class'> & {
  children: string
  class?: string
  streaming?: boolean
  label?: string
}

export function Reasoning(props: ReasoningProps) {
  const rest = omit(props, 'class', 'children', 'streaming', 'label')
  const label = () => props.label ?? 'Thinking'
  return (
    <Collapsible {...rest} class={cn('group/reasoning not-prose', props.class)}>
      <CollapsibleTrigger
        class="flex items-center gap-1.5 font-mono text-[12px] text-muted-foreground transition-colors hover:text-foreground"
        data-ui="transcript-meta"
      >
        <ChevronRight
          aria-hidden="true"
          class="size-3 transition-transform group-data-open/reasoning:rotate-90"
        />
        <Show when={props.streaming} fallback={<span>{label()}</span>}>
          <Shimmer>{`${label()}…`}</Shimmer>
        </Show>
      </CollapsibleTrigger>
      <CollapsibleContent class="mt-1.5 border-l-2 border-border pl-3 text-[13px] text-muted-foreground italic">
        <Markdown streaming={props.streaming} text={props.children} />
      </CollapsibleContent>
    </Collapsible>
  )
}
