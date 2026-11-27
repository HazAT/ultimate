import { ChevronRight } from '@lucide/solid'
import type { JSX } from '@solidjs/web'
import { createMemo, Match, Show, Switch } from 'solid-js'
import { setAsideIds } from '@/app/compact.ts'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible.solid.tsx'
import { useFold, useConversationId, useTranscript, type SolidEntryProps } from '@/sdk/solid'
import {
  breakdownAt,
  diffAt,
  opensContext,
  ownStart,
  removesAll,
  systemOf,
} from './breakdown.shared.ts'
import type { Diff } from './breakdown.shared.ts'
import { changeCounts, DiffBody, Header, signed } from './parts.solid.tsx'
import { InheritedPromptStart } from './pinned.solid.tsx'

function ContextAt(props: { anchor: number; label: string; fallback?: JSX.Element }) {
  const entries = useTranscript()
  const breakdown = createMemo(() => breakdownAt(entries(), props.anchor))
  return (
    <Show fallback={props.fallback} when={breakdown().system}>
      <Header breakdown={breakdown()} label={props.label} />
    </Show>
  )
}

export function Start() {
  const entries = useTranscript()
  const id = useConversationId()
  const own = createMemo(() => ownStart(entries(), id()))
  return (
    <Show when={own() >= 0}>
      <ContextAt
        anchor={own()}
        fallback={<InheritedPromptStart />}
        label={`Transcript start context #${id()}`}
      />
    </Show>
  )
}

export function ContextStart(props: SolidEntryProps) {
  const entries = useTranscript()
  const id = useConversationId()
  const index = createMemo(() =>
    entries().findIndex((candidate) => candidate.id === props.entry.id),
  )
  return (
    <Switch>
      <Match when={index() < 0}>{props.core}</Match>
      <Match when={index() !== ownStart(entries(), id())}>
        <div class="flex flex-col gap-3">
          {props.core}
          <ContextAt anchor={index()} label={`Context at entry #${props.entry.id}`} />
        </div>
      </Match>
    </Switch>
  )
}

function Marker(props: { id: number; diff: Diff }) {
  const fold = useFold(() => props.id)
  const label = () => `System prompt diff #${props.id}`
  const bind = [fold.open, fold.setOpen] as const
  return (
    <Collapsible
      bind={fold.folds() ? bind : undefined}
      class="group/marker"
      data-context-diff={props.id}
    >
      <CollapsibleTrigger aria-label={`Toggle ${label()}`} class="w-full">
        <div
          class="flex items-center gap-3 font-mono text-[11px] text-muted-foreground/70 before:h-px before:flex-1 before:bg-border/70 after:h-px after:flex-1 after:bg-border/70 hover:text-muted-foreground"
          data-ui="transcript-meta"
        >
          <span class="flex max-w-[85%] min-w-0 items-center gap-1.5">
            <ChevronRight class="size-3 shrink-0 transition-transform group-data-open/marker:rotate-90" />
            <span class="truncate">system prompt · {changeCounts(props.diff) || 'unchanged'}</span>
            <span class="shrink-0 tabular-nums">· {signed(props.diff.delta)} tokens</span>
          </span>
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent class="mt-2 rounded-md border border-border/70 bg-card/40 font-mono text-[11.5px]">
        <DiffBody diff={props.diff} label={label()} />
      </CollapsibleContent>
    </Collapsible>
  )
}

export function SystemEntry(props: SolidEntryProps) {
  const entries = useTranscript()
  const id = useConversationId()
  const index = createMemo(() =>
    entries().findIndex((candidate) => candidate.id === props.entry.id),
  )
  const suppressed = () =>
    opensContext(entries(), index(), Math.max(0, ownStart(entries(), id()))) ||
    (removesAll(props.entry) && !!systemOf(entries()[index() + 1]))
  const diff = createMemo(() => {
    const transcript = entries()
    const at = index()
    const aside = setAsideIds(transcript)
    return diffAt(transcript, at, aside.has(props.entry.id) ? undefined : aside)
  })
  return (
    <Show when={index() >= 0 && systemOf(props.entry)} fallback={props.core}>
      <Show when={!suppressed()}>
        <Marker diff={diff()} id={props.entry.id} />
      </Show>
    </Show>
  )
}
