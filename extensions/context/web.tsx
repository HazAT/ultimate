import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  defineWebExtension,
  formatDuration,
  formatTokens,
  plural,
  setAsideIds,
  useConversation,
  useFold,
  useTranscript,
} from '@/sdk'
import type { EntryRecord } from '@/sdk'
import { ChevronRightIcon, DatabaseZapIcon } from 'lucide-react'
import { cacheBusts } from '../../lib/context-usage.ts'
import type { CacheBust } from '../../lib/context-usage.ts'
import { breakdownAt, diffAt, opensContext, ownStart, removesAll, systemOf } from './breakdown.ts'
import type { Diff } from './breakdown.ts'
import { DiffBody, Header, signed } from './parts.tsx'
import { PinnedPrompt } from './pinned.tsx'

/** The breakdown of the context starting at entry index `anchor`; nothing until its first system prompt. */
function ContextAt({ anchor }: { anchor: number }) {
  const entries = useTranscript()
  const breakdown = useMemo(() => breakdownAt(entries, anchor), [entries, anchor])
  return breakdown.system ? <Header breakdown={breakdown} /> : null
}

/** Above the first row of a fully loaded transcript: the conversation's first context. */
function Start() {
  const entries = useTranscript()
  const id = useConversation((conversation) => conversation.id)
  const own = ownStart(entries, id)
  return own < 0 ? null : <ContextAt anchor={own} />
}

/**
 * A context start: the conversation's own first one says nothing, the header above shows what it injected; a later
 * one keeps its card and shows its context's breakdown under it.
 */
function ContextStart({ entry, core }: { entry: EntryRecord; core: ReactNode }) {
  const entries = useTranscript()
  const id = useConversation((conversation) => conversation.id)
  const index = entries.findIndex((candidate) => candidate.id === entry.id)
  if (index < 0) return core
  if (index === ownStart(entries, id)) return null
  return (
    <div className="flex flex-col gap-3">
      {core}
      <ContextAt anchor={index} />
    </div>
  )
}

/** A divider line that opens to the prompt diff under it. */
function Marker({ id, diff, children }: { id: number; diff: Diff; children: ReactNode }) {
  // In a chat its open state is kept like a card's; elsewhere it opens and closes on its own.
  const fold = useFold(id)
  return (
    <Collapsible
      className="group/marker"
      data-context-diff={id}
      {...(fold.folds && { open: fold.open, onOpenChange: fold.setOpen })}
    >
      <CollapsibleTrigger className="w-full cursor-pointer">
        <div className="flex items-center gap-3 font-mono text-[0.6875rem] text-muted-foreground before:h-px before:flex-1 before:bg-border/70 after:h-px after:flex-1 after:bg-border/70 hover:text-muted-foreground">
          <span className="flex max-w-[85%] min-w-0 items-center gap-1.5">
            <ChevronRightIcon className="size-3 shrink-0 transition-transform group-data-[state=open]/marker:rotate-90" />
            <span className="truncate">{children}</span>
            <span className="shrink-0 tabular-nums">· {signed(diff.delta)} tokens</span>
          </span>
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 rounded-md border border-border/70 bg-card/40 font-mono text-[0.7188rem]">
        <DiffBody diff={diff} />
      </CollapsibleContent>
    </Collapsible>
  )
}

/**
 * A `pi.system` entry. A context's first one shows nothing: the header above its first input breaks it down. A later
 * one is a quiet marker of what changed, opening to its diff; a remove-all entry right before a reordered re-add
 * belongs to that re-add's marker and shows nothing.
 */
function SystemEntry({ entry, core }: { entry: EntryRecord; core: ReactNode }) {
  const entries = useTranscript()
  const id = useConversation((conversation) => conversation.id)
  const index = entries.findIndex((candidate) => candidate.id === entry.id)
  const diff = useMemo(() => {
    if (index < 0) return undefined
    // Patches a go-back set aside left the model's context; a set-aside one still shows what it changed back then.
    const aside = setAsideIds(entries)
    return diffAt(entries, index, aside.has(entries[index].id) ? undefined : aside)
  }, [entries, index])
  if (!systemOf(entry) || !diff) return core
  if (opensContext(entries, index, Math.max(0, ownStart(entries, id)))) return null
  if (removesAll(entry) && systemOf(entries[index + 1])) return null
  const changes = [
    diff.sections.length > 0 && plural(diff.sections.length, 'section'),
    diff.tools.length > 0 && plural(diff.tools.length, 'tool'),
  ]
  return (
    <Marker diff={diff} id={entry.id}>
      system prompt · {changes.filter(Boolean).join(' · ') || 'unchanged'}
    </Marker>
  )
}

const causes: Record<CacheBust['cause'], (bust: CacheBust) => string> = {
  system: () => 'after the system prompt change',
  model: () => 'after a model switch',
  expired: (bust) => `expired after ${formatDuration(bust.gap)} idle`,
  prefix: () => 'earlier context changed',
}

/**
 * A response that rebuilt the prompt cache: a quiet warning line above it with what it wrote fresh, what it still read
 * against the prompt before, and why. A response split over several rows shows it on its first.
 */
function CacheRebuilt({
  entry,
  core,
  blocks,
}: {
  entry: EntryRecord
  core: ReactNode
  blocks?: readonly number[]
}) {
  const bust = cacheBusts(useTranscript()).get(entry.id)
  if (!bust || (blocks && blocks[0] !== 0)) return core
  return (
    <div className="flex flex-col gap-3">
      <div
        className="flex items-center gap-3 font-mono text-[0.6875rem] text-warning/80 before:h-px before:flex-1 before:bg-warning/25 after:h-px after:flex-1 after:bg-warning/25"
        data-cache-rebuilt={entry.id}
      >
        <span className="flex max-w-[85%] min-w-0 items-center gap-1.5">
          <DatabaseZapIcon className="size-3 shrink-0" />
          <span className="truncate">
            cache rebuilt · {formatTokens(bust.written)} written · {formatTokens(bust.read)} of{' '}
            {formatTokens(bust.before)} read · {causes[bust.cause](bust)}
          </span>
        </span>
      </div>
      {core}
    </div>
  )
}

export default defineWebExtension({
  slots: { 'transcript.start': [Start], 'transcript.top': [PinnedPrompt] },
  entries: {
    'pi.system': SystemEntry,
    'pi.reset': ContextStart,
    'pi.compaction': ContextStart,
    'pi.assistant': CacheRebuilt,
  },
})
