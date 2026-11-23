import type { EntryRecord } from '@earendil-works/pi-durable'
import { Scale } from '@lucide/solid'
import { For, Show, createMemo } from 'solid-js'
import { ROOT, cn, useConversationId, useDocOf } from '@/sdk/solid'
import { MessagesDoc } from './refs.ts'
import type { Judged } from './refs.ts'

const percent = (p: number) => `${Math.round(p * 100)}%`

export function JudgedChip(props: { judged: Judged; class?: string }) {
  const verdict = () => {
    const judged = props.judged
    if ('error' in judged)
      return {
        woke: true,
        text: 'woke · no verdict',
        title: `Jev could not judge this answer (${judged.error}), so it woke the starter.`,
      }
    const woke = judged.report >= 0.5
    return {
      woke,
      text: `${woke ? 'woke' : 'note'} · ${percent(woke ? judged.report : 1 - judged.report)}`,
      title: woke
        ? `Jev judged that the starter must act on or know this answer (${percent(judged.report)}), so it woke it.`
        : `Jev judged this back-and-forth with the user (${percent(1 - judged.report)}), so the starter reads it as a note without waking.`,
    }
  }
  return (
    <span
      class={cn(
        'inline-flex h-5 max-w-full min-w-0 shrink-0 items-center gap-1 rounded-full border border-border/70 bg-background px-1.5 font-mono text-[10px] font-normal text-muted-foreground',
        props.class,
      )}
      data-judged={verdict().woke ? 'report' : 'note'}
      title={verdict().title}
    >
      <Scale aria-hidden="true" class={cn('size-3 shrink-0', verdict().woke && 'text-brand')} />
      <span class="truncate">{verdict().text}</span>
    </span>
  )
}

export function JudgedAnswerLabel(props: { entry: EntryRecord }) {
  const log = useDocOf(() => ROOT, MessagesDoc)
  const conversation = useConversationId()
  const judged = createMemo(() =>
    (log()?.messages ?? []).filter(
      (m) => m.from === conversation() && m.judged?.answer === props.entry.id,
    ),
  )
  return (
    <For each={judged()} keyed={(message) => message.id}>
      {(message) => (
        <Show when={message().judged}>{(verdict) => <JudgedChip judged={verdict()} />}</Show>
      )}
    </For>
  )
}
