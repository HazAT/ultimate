/** @jsxImportSource @solidjs/web */
/** Lineage for other extensions' Solid code: a memory's chip that opens it on the Memory surface. */
import { Brain } from '@lucide/solid'
import { omit } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { cn, showSurface, useUiState } from '@/sdk/solid'
import { MEMORY_FOCUS, MEMORY_SURFACE, memoryChipClass } from './memory-chip.ts'

export { MEMORY_SURFACE } from './memory-chip.ts'

/** Opens the Memory surface, on memory `slug` unfolded when given. */
export function useOpenMemory() {
  const [, setFocus] = useUiState<string | null>(MEMORY_FOCUS, null)
  return (slug?: string) => {
    if (slug) setFocus(slug)
    showSurface(MEMORY_SURFACE)
  }
}

/**
 * Memory `slug` as a small pill that opens it on the Memory surface; `name` is its agent name, `title` its hover text,
 * and `data-*` attributes pass through to the button.
 */
export function MemoryChip(
  props: { slug: string; name: string; title?: string; class?: string } & {
    [data: `data-${string}`]: string
  },
) {
  const openMemory = useOpenMemory()
  const data = omit(props, 'slug', 'name', 'title', 'class')
  return (
    <Button
      {...data}
      aria-label={props.name}
      class={cn(memoryChipClass, 'justify-start font-normal', props.class)}
      data-memory-chip={props.slug}
      onClick={() => openMemory(props.slug)}
      size={null}
      title={props.title ?? `Open ${props.slug} in Memory`}
      variant={null}
    >
      <Brain class="size-3 shrink-0 text-brand" />
      <span class="truncate">{props.slug}</span>
    </Button>
  )
}
