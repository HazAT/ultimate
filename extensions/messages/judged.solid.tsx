import type { EntryRecord } from '@earendil-works/pi-durable'
import { Scale } from '@lucide/solid'
import { Show } from 'solid-js'
import { cn, useDocOf } from '@/sdk/solid'
import { JudgementsDoc } from './refs.ts'
import type { Judged } from './refs.ts'

const percent = (p: number) => `${Math.round(p * 100)}%`

export function JudgedChip(props: { judged: Judged }) {
  const verdict = () => {
    const judged = props.judged
    if ('error' in judged)
      return {
        woke: true,
        text: 'report · no verdict',
        title: `No verdict from Jev (${judged.error}), so it recommends a report.`,
      }
    const woke = judged.report >= 0.5
    return {
      woke,
      text: `${woke ? 'report' : 'note'} · ${percent(woke ? judged.report : 1 - judged.report)}`,
      title: woke
        ? `Jev recommends a report: the starter must act on or know this answer (${percent(judged.report)}).`
        : `Jev recommends a note: back-and-forth with the user (${percent(1 - judged.report)}), read later without waking.`,
    }
  }
  return (
    <span
      class="inline-flex h-5 max-w-full min-w-0 shrink-0 items-center gap-1 rounded-full border border-border/70 bg-background px-1.5 font-mono text-[10px] font-normal text-muted-foreground"
      data-judged={verdict().woke ? 'report' : 'note'}
      title={verdict().title}
    >
      <Scale aria-hidden="true" class={cn('size-3 shrink-0', verdict().woke && 'text-brand')} />
      <span class="truncate">{verdict().text}</span>
    </span>
  )
}

export function JudgedAnswerLabel(props: { entry: EntryRecord }) {
  const judgements = useDocOf(() => props.entry.conversationId, JudgementsDoc)
  return (
    <Show when={judgements()?.answers[props.entry.id]}>
      {(verdict) => <JudgedChip judged={verdict()} />}
    </Show>
  )
}
