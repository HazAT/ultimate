import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  defineWebExtension,
  formatDuration,
  formatTokens,
  plural,
  Rendered,
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
import { CacheRebuiltLine } from './ui.tsx'

function ContextAt({ anchor }: { anchor: number }) {
  const entries = useTranscript()
  const breakdown = useMemo(() => breakdownAt(entries, anchor), [entries, anchor])
  return breakdown.system ? <Header breakdown={breakdown} /> : null
}

function Start() {
  const entries = useTranscript()
  const id = useConversation((conversation) => conversation.id)
  const own = ownStart(entries, id)
  return own < 0 ? null : <ContextAt anchor={own} />
}

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

function Marker({ id, diff, children }: { id: number; diff: Diff; children: ReactNode }) {
  const fold = useFold(id)
  return (
    <Collapsible
      className="group/marker"
      data-context-diff={id}
      {...(fold.folds && { open: fold.open, onOpenChange: fold.setOpen })}
    >
      <CollapsibleTrigger className="w-full cursor-pointer">
        <div
          className="flex items-center gap-3 font-mono text-[11px] text-muted-foreground/70 before:h-px before:flex-1 before:bg-border/70 after:h-px after:flex-1 after:bg-border/70 hover:text-muted-foreground"
          data-ui="transcript-meta"
        >
          <span className="flex max-w-[85%] min-w-0 items-center gap-1.5">
            <ChevronRightIcon className="size-3 shrink-0 transition-transform group-data-[state=open]/marker:rotate-90" />
            <span className="truncate">{children}</span>
            <span className="shrink-0 tabular-nums">· {signed(diff.delta)} tokens</span>
          </span>
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 rounded-md border border-border/70 bg-card/40 font-mono text-[11.5px]">
        <DiffBody diff={diff} />
      </CollapsibleContent>
    </Collapsible>
  )
}

function SystemEntry({ entry, core }: { entry: EntryRecord; core: ReactNode }) {
  const entries = useTranscript()
  const id = useConversation((conversation) => conversation.id)
  const index = entries.findIndex((candidate) => candidate.id === entry.id)
  const diff = useMemo(() => {
    if (index < 0) return undefined
    const aside = setAsideIds(entries)
    const historicalDiffForSetAsideEntry = aside.has(entries[index].id)
    return diffAt(entries, index, historicalDiffForSetAsideEntry ? undefined : aside)
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
  if (!bust) return core
  const continuationOfSplitResponse = blocks && blocks[0] !== 0
  if (continuationOfSplitResponse) return core
  return (
    <div className="flex flex-col gap-3">
      <Rendered input={{ entry, bust }} point={CacheRebuiltLine}>
        <div
          className="flex items-center gap-3 font-mono text-[11px] text-warning/80 before:h-px before:flex-1 before:bg-warning/25 after:h-px after:flex-1 after:bg-warning/25"
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
      </Rendered>
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
