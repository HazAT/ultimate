/** @jsxImportSource @solidjs/web */
/** Lineage for other extensions' Solid code: a memory's chip that opens it on the Memory surface. */
import { Brain } from '@lucide/solid'
import { omit } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { cn, showSurface, useUiState } from '@/sdk/solid'
import { MEMORY_FOCUS, MEMORY_SURFACE, memoryChipClass } from './memory-chip.ts'

/**
 * Memory `slug` as a small pill that opens it on the Memory surface; `name` is its agent name, `title` its hover text,
 * and `data-*` attributes pass through to the button.
 */
export function MemoryChip(
  props: { slug: string; name: string; title?: string; class?: string } & {
    [data: `data-${string}`]: string
  },
) {
  const [, setFocus] = useUiState<string | null>(MEMORY_FOCUS, null)
  const data = omit(props, 'slug', 'name', 'title', 'class')
  return (
    <Button
      {...data}
      aria-label={props.name}
      class={cn(memoryChipClass, 'justify-start font-normal', props.class)}
      data-memory-chip={props.slug}
      onClick={() => {
        setFocus(props.slug)
        showSurface(MEMORY_SURFACE)
      }}
      size={null}
      title={props.title ?? `Open ${props.slug} in Memory`}
      variant={null}
    >
      <Brain class="size-3 shrink-0 text-brand" />
      <span class="truncate">{props.slug}</span>
    </Button>
  )
}
