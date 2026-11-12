import { PencilIcon } from 'lucide-react'
import { Fold, formatTime, Provided, useCompact, useTranscript } from '@/sdk'
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

/** The entry kinds a summary task writes, each with the word the folded line names it by. */
const summaryKinds: Record<string, string> = {
  'conversations.intent-summarized': 'intent',
  'conversations.title-changed': 'title',
  'conversations.feature-changed': 'tag',
  'conversations.summarized': 'summary',
  'conversations.assessed': 'reply',
  'conversations.summary-discarded': 'summary',
}
/**
 * Entries that show no row of their own, so summary lines on either side still sit next to each other: a tool result
 * shows inside the call that made it.
 */
const invisible = new Set(['conversations.identity', 'pi.tool-result'])

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

/**
 * The run of summary entries `entry` belongs to, oldest first, when it starts the run; undefined when an earlier entry
 * of the run renders it.
 */
function runFrom(entries: readonly EntryRecord[], entry: EntryRecord) {
  const shown = entries.filter(
    (other) => other.conversationId === entry.conversationId && !invisible.has(other.kind),
  )
  const at = shown.findIndex((other) => other.id === entry.id)
  if (at < 0) return [entry]
  if (at > 0 && shown[at - 1].kind in summaryKinds) return undefined
  const end = shown.findIndex((other, index) => index > at && !(other.kind in summaryKinds))
  return shown.slice(at, end < 0 ? undefined : end)
}

export function SummaryAction({ entry }: { entry: EntryRecord }) {
  const compact = useCompact()
  const run = runFrom(useTranscript(), entry)
  // An agent in compact mode and a root get no summaries; older lines would only interrupt them.
  if (compact || !run) return null
  return (
    <Provided input={entry.conversationId} point={Unsummarized}>
      {(unsummarized) => (unsummarized ? null : <SummaryRun run={run} />)}
    </Provided>
  )
}

/** Neighbouring summary lines fold into one quiet line naming what changed; opening it shows each line. */
function SummaryRun({ run }: { run: readonly EntryRecord[] }) {
  const names = [...new Set(run.map((entry) => summaryKinds[entry.kind]))]
  const date = new Date((run.at(-1)!.data as { at: number }).at)
  return (
    <Fold
      always
      card={`summaries:${run[0].id}`}
      summary={
        <>
          <PencilIcon aria-hidden className="size-3 shrink-0" />
          <span>{names.join(' · ')} updated</span>
          <time dateTime={date.toISOString()} title={date.toLocaleString()}>
            {formatTime(date)}
          </time>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        {run.map((entry) => (
          <SummaryLine entry={entry} key={entry.id} />
        ))}
      </div>
    </Fold>
  )
}

function SummaryLine({ entry }: { entry: EntryRecord }) {
  const text = summaryText(entry)
  const date = new Date((entry.data as { at: number }).at)
  return (
    <div
      className="flex items-baseline gap-2 font-mono text-[11px] text-muted-foreground"
      data-ui="transcript-meta"
    >
      <PencilIcon aria-hidden className="size-3 shrink-0 self-center" />
      <span className="min-w-0 break-words">{text}</span>
      <time
        className="shrink-0 text-muted-foreground/70"
        dateTime={date.toISOString()}
        title={date.toLocaleString()}
      >
        {formatTime(date)}
      </time>
    </div>
  )
}
