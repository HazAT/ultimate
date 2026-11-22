/** @jsxImportSource @solidjs/web */
/**
 * Lineage for other extensions' browser code: the project's roots, a root's tally, landing links and compaction, the
 * branch and root events, and the Memory surface with its header point.
 */
import { Brain } from '@lucide/solid'
import { omit } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { cn, getState, ROOT, showSurface, useDocOf, useUiState } from '@/sdk/solid'
import type { ConversationId } from '@earendil-works/pi-durable'
import { RootsDoc } from './refs.ts'
import { MEMORY_FOCUS, MEMORY_SURFACE, memoryChipClass } from './memory-chip.ts'

/**
 * `MEMORY_SURFACE` is the id of lineage's Memory surface (every root's project memory, grouped by kind);
 * `MEMORY_FOCUS` the UI state key of the memory it shows unfolded and scrolled into view.
 */
export { MEMORY_FOCUS, MEMORY_SURFACE } from './memory-chip.ts'
export {
  AbstractEntry,
  Branched,
  CompactAction,
  FinishedEntry,
  MemoryDoc,
  RecentAction,
  Rooted,
  RootsDoc,
  TallyDoc,
} from './refs.ts'
export type { MemoryItem } from './refs.ts'
/** What the Memory surface shows above the memories (`dream` provides its Dream button). */
export { MemoryHeader } from './points.ts'

/** The project's roots, live in every client; undefined until the stream delivers them. */
export function useRoots() {
  const roots = useDocOf(() => ROOT, RootsDoc)
  return () => roots()?.roots
}

/** The project's roots as last streamed, for synchronous readers such as a command's `when`. */
export function getRoots() {
  return (
    getState().docsOf[ROOT]?.[RootsDoc.kind] as { roots: ConversationId[] } | null | undefined
  )?.roots
}

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
