import { PencilIcon } from 'lucide-react'
import { Fold, formatTime, Provided, useCompact, useTranscript } from '@/sdk'
import type { EntryRecord } from '@/sdk'
import {
  TitleChanged,
  FeatureChanged,
  IntentSummarized,
  SpawnSummarized,
  ReplySummarized,
  SummaryDiscarded,
} from './entries.ts'
import { Unsummarized } from './ui.tsx'

function isSummary(entry: EntryRecord) {
  return (
    TitleChanged.is(entry) ||
    FeatureChanged.is(entry) ||
    IntentSummarized.is(entry) ||
    SpawnSummarized.is(entry) ||
    ReplySummarized.is(entry) ||
    SummaryDiscarded.is(entry)
  )
}

const summaryKinds: Record<string, string> = {
  'conversations.intent-summarized': 'intent',
  'conversations.title-changed': 'title',
  'conversations.feature-changed': 'tag',
  'conversations.summarized': 'summary',
  'conversations.assessed': 'reply',
  'conversations.summary-discarded': 'summary',
}
const invisible = new Set(['conversations.identity', 'pi.tool-result'])

function summaryText(entry: EntryRecord) {
  if (IntentSummarized.is(entry)) return `Intent: ${entry.data.summary}`
  if (TitleChanged.is(entry)) return `Title changed to “${entry.data.title}”`
  if (FeatureChanged.is(entry))
    return `Tag changed from “${entry.data.from}” to “${entry.data.feature}”`
  if (SpawnSummarized.is(entry)) return `Summary: ${entry.data.summary}`
  if (ReplySummarized.is(entry)) return `Reply: ${entry.data.activity}`
  if (!SummaryDiscarded.is(entry)) return ''
  return entry.data.reason === 'stale'
    ? 'Summary superseded by newer work'
    : `Summary unavailable: ${entry.data.cause}`
}

function summaryRunAtFirstVisibleEntry(entries: readonly EntryRecord[], entry: EntryRecord) {
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
  const run = summaryRunAtFirstVisibleEntry(useTranscript(), entry)
  if (compact || !run) return null
  return (
    <Provided input={entry.conversationId} point={Unsummarized}>
      {(unsummarized) => (unsummarized ? null : <SummaryRun run={run} />)}
    </Provided>
  )
}

function SummaryRun({ run }: { run: readonly EntryRecord[] }) {
  const names = [...new Set(run.map((entry) => summaryKinds[entry.kind]))]
  const last = run.at(-1)!
  if (!isSummary(last)) return null
  const date = new Date(last.data.at)
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
  if (!isSummary(entry)) return null
  const date = new Date(entry.data.at)
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
