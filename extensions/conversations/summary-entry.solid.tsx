/** @jsxImportSource @solidjs/web */
import { Pencil } from '@lucide/solid'
import { For, Show, createMemo } from 'solid-js'
import {
  Fold,
  useProvided,
  formatTime,
  useCompact,
  useTranscript,
  type EntryRecord,
} from '@/sdk/solid'
import {
  TitleChanged,
  FeatureChanged,
  IntentSummarized,
  SpawnSummarized,
  ReplySummarized,
  SummaryDiscarded,
} from './entries.ts'
import { Unsummarized } from './ui.solid.tsx'

function summary(entry: EntryRecord) {
  if (IntentSummarized.is(entry))
    return line('intent', `Intent: ${entry.data.summary}`, entry.data.at)
  if (TitleChanged.is(entry))
    return line('title', `Title changed to “${entry.data.title}”`, entry.data.at)
  if (FeatureChanged.is(entry))
    return line(
      'tag',
      `Tag changed from “${entry.data.from}” to “${entry.data.feature}”`,
      entry.data.at,
    )
  if (SpawnSummarized.is(entry))
    return line('summary', `Summary: ${entry.data.summary}`, entry.data.at)
  if (ReplySummarized.is(entry))
    return line('reply', `Reply: ${entry.data.activity}`, entry.data.at)
  if (SummaryDiscarded.is(entry))
    return line(
      'summary',
      entry.data.reason === 'stale'
        ? 'Summary superseded by newer work'
        : `Summary unavailable: ${entry.data.cause}`,
      entry.data.at,
    )
  return undefined
}

const line = (name: string, text: string, at: number) => ({ name, text, at })
const invisible = new Set(['conversations.identity', 'pi.tool-result'])

function firstSummaryRun(entries: readonly EntryRecord[], entry: EntryRecord) {
  const shown = entries.filter(
    (other) => other.conversationId === entry.conversationId && !invisible.has(other.kind),
  )
  const at = shown.findIndex((other) => other.id === entry.id)
  if (at > 0 && summary(shown[at - 1])) return []
  const lines = []
  for (const item of at < 0 ? [entry] : shown.slice(at)) {
    const row = summary(item)
    if (!row) break
    lines.push({ id: item.id, ...row })
  }
  return lines
}

export function HiddenIdentity(_props: { entry: EntryRecord }) {
  return null
}

export function SummaryAction(props: { entry: EntryRecord }) {
  const compact = useCompact()
  const transcript = useTranscript()
  const run = createMemo(() => (compact() ? [] : firstSummaryRun(transcript(), props.entry)))
  return (
    <Show when={run().length}>
      <SummaryRun entry={props.entry} run={run()} />
    </Show>
  )
}

function SummaryRun(props: { entry: EntryRecord; run: ReturnType<typeof firstSummaryRun> }) {
  const unsummarized = useProvided(Unsummarized, () => props.entry.conversationId)
  const names = () => [...new Set(props.run.map((row) => row.name))].join(' · ')
  return (
    <Show when={!unsummarized()}>
      <Fold
        always
        card={`summaries:${props.entry.id}`}
        label={`Summary updates for entry #${props.entry.id}`}
        summary={
          <>
            <Pencil aria-hidden="true" class="size-3 shrink-0" />
            <span>{names()} updated</span>
            <Stamp at={props.run.at(-1)!.at} />
          </>
        }
      >
        <div class="flex flex-col gap-2">
          <For each={props.run} keyed={(row) => row.id}>
            {(row) => (
              <div
                class="flex items-baseline gap-2 font-mono text-[11px] text-muted-foreground"
                data-ui="transcript-meta"
              >
                <Pencil aria-hidden="true" class="size-3 shrink-0 self-center" />
                <span class="min-w-0 break-words">{row().text}</span>
                <Stamp at={row().at} class="shrink-0 text-muted-foreground/70" />
              </div>
            )}
          </For>
        </div>
      </Fold>
    </Show>
  )
}

function Stamp(props: { at: number; class?: string }) {
  const date = createMemo(() => new Date(props.at))
  return (
    <time class={props.class} datetime={date().toISOString()} title={date().toLocaleString()}>
      {formatTime(date())}
    </time>
  )
}
