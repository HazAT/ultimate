/**
 * Lineage for other extensions' browser code: the project's roots, a root's tally, landing links and compaction, the
 * branch and root events, and the Memory surface with its header point.
 */
import { BrainIcon } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'
import { cn, definePoint, getState, useDocOf, useUiState, useUltimate } from '@/sdk'
import { RootsDoc } from './refs.ts'

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

/** The id of lineage's Memory surface: every root's project memory, grouped by kind, in a reading column. */
export const MEMORY_SURFACE = 'memory'
/** The UI state key of the memory the Memory surface shows unfolded and scrolled into view. */
export const MEMORY_FOCUS = 'ext.lineage.memoryFocus'

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
      className={cn(
        'inline-flex h-5 max-w-full min-w-0 cursor-pointer items-center gap-1 rounded-full border border-border/70 bg-background px-1.5 font-mono text-[10px] text-muted-foreground outline-none hover:border-brand/50 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring',
        className,
      )}
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

/** The composer's reading column, as the core lays it out; a card in place of a root's composer uses it. */
export const column = (dock?: boolean) =>
  dock ? 'w-full px-4' : 'mx-auto w-full max-w-(--reading-width,46rem) px-3 sm:px-6'

/** What the Memory surface shows above the memories (`dream` provides its Dream button). */
export const MemoryHeader = definePoint<null, ReactNode>('lineage.memory-header')

/** Conversation 1 keeps the `lineage.roots` document. */
const keeper = 1

/** The project's roots, live in every client; undefined until the stream delivers them. */
export function useRoots() {
  return useDocOf(keeper, RootsDoc)?.roots
}

/** The roots as last streamed, for synchronous readers such as a command's `when`; a mounted `useRoots` keeps them. */
export function getRoots() {
  return (getState().docsOf[keeper]?.[RootsDoc.kind] as { roots: number[] } | null | undefined)
    ?.roots
}
