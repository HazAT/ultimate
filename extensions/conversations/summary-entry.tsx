import { PencilIcon } from 'lucide-react'
import { formatTime, Provided, useCompact } from '@/sdk'
import type { EntryRecord } from '@/sdk'
import type {
  FeatureChange,
  IntentSummary,
  ReplySummary,
  SpawnSummary,
  SummaryDiscard,
  TitleChange,
} from './types.ts'
import { Unsummarized } from './ui.tsx'

/** What a summary task concluded, as one quiet line; each entry traces to its task by `byTaskId`. */
function summaryText(entry: EntryRecord) {
  switch (entry.kind) {
    case 'conversations.intent-summarized':
      return `Intent: ${(entry.data as IntentSummary).summary}`
    case 'conversations.title-changed':
      return `Title changed to “${(entry.data as TitleChange).title}”`
    case 'conversations.feature-changed': {
      const data = entry.data as FeatureChange
      return `Tag changed from “${data.from}” to “${data.feature}”`
    }
    case 'conversations.summarized':
      return `Summary: ${(entry.data as SpawnSummary).summary}`
    case 'conversations.assessed':
      return `Reply: ${(entry.data as ReplySummary).activity}`
    default: {
      const data = entry.data as SummaryDiscard
      return data.reason === 'stale'
        ? 'Summary superseded by newer work'
        : `Summary unavailable: ${data.cause}`
    }
  }
}

export function SummaryAction({ entry }: { entry: EntryRecord }) {
  const compact = useCompact()
  // An agent in compact mode and a root get no summaries; older lines would only interrupt them.
  if (compact) return null
  return (
    <Provided input={entry.conversationId} point={Unsummarized}>
      {(unsummarized) => (unsummarized ? null : <SummaryLine entry={entry} />)}
    </Provided>
  )
}

function SummaryLine({ entry }: { entry: EntryRecord }) {
  const text = summaryText(entry)
  const date = new Date((entry.data as { at: number }).at)
  return (
    <div
      className="flex items-baseline gap-2 font-mono text-[0.6875rem] text-muted-foreground"
      data-ui="transcript-meta"
    >
      <PencilIcon aria-hidden className="size-3 shrink-0 self-center" />
      <span className="min-w-0 break-words">{text}</span>
      <time
        className="shrink-0 text-muted-foreground"
        dateTime={date.toISOString()}
        title={date.toLocaleString()}
      >
        {formatTime(date)}
      </time>
    </div>
  )
}
