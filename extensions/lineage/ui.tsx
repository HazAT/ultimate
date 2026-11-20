/**
 * Lineage for other extensions' browser code: the project's roots, a root's tally, landing links and compaction, the
 * branch and root events, and the Memory surface with its header point.
 */
import { ROOT } from '@/sdk'
import type { ConversationId } from '@earendil-works/pi-durable'
import { BrainIcon } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'
import { cn, definePoint, getState, useDocOf, useUiState, useUltimate } from '@/sdk'
import { RootsDoc } from './refs.ts'
export { FinishedEntry, AbstractEntry } from './refs.ts'

export {
  Branched,
  CompactAction,
  MemoryDoc,
  RecentAction,
  Rooted,
  RootsDoc,
  TallyDoc,
} from './refs.ts'
export type { MemoryItem } from './refs.ts'

/**
 * `MEMORY_SURFACE` is the id of lineage's Memory surface (every root's project memory, grouped by kind);
 * `MEMORY_FOCUS` the UI state key of the memory it shows unfolded and scrolled into view.
 */
export { MEMORY_FOCUS, MEMORY_SURFACE } from './memory-chip.ts'
import { MEMORY_FOCUS, MEMORY_SURFACE, memoryChipClass } from './memory-chip.ts'

/** A function that opens the Memory surface, on memory `slug` unfolded when given. */
export function useOpenMemory() {
  const { showSurface } = useUltimate()
  const [, setFocus] = useUiState<string | null>(MEMORY_FOCUS, null)
  return (slug?: string) => {
    if (slug) setFocus(slug)
    showSurface(MEMORY_SURFACE)
  }
}

/** A memory's slug as a small pill that opens it on the Memory surface. */
export function MemoryChip({
  slug,
  className,
  ...props
}: { slug: string } & Omit<ComponentProps<'button'>, 'onClick' | 'type'>) {
  const openMemory = useOpenMemory()
  return (
    <button
      className={cn(memoryChipClass, className)}
      onClick={() => openMemory(slug)}
      title={`Open ${slug} in Memory`}
      type="button"
      {...props}
    >
      <BrainIcon className="size-3 shrink-0 text-brand" />
      <span className="truncate">{slug}</span>
    </button>
  )
}

/** What the Memory surface shows above the memories (`dream` provides its Dream button). */
export const MemoryHeader = definePoint<null, ReactNode>('lineage.memory-header')

/** Conversation 1 keeps the `lineage.roots` document. */
const keeper = ROOT

/** The project's roots, live in every client; undefined until the stream delivers them. */
export function useRoots() {
  return useDocOf(keeper, RootsDoc)?.roots
}

/** The roots as last streamed, for synchronous readers such as a command's `when`; a mounted `useRoots` keeps them. */
export function getRoots() {
  return (
    getState().docsOf[keeper]?.[RootsDoc.kind] as { roots: ConversationId[] } | null | undefined
  )?.roots
}
