import type { ConversationId, Entry, EntryRecord, TypedEntry } from '@earendil-works/pi-durable'
import {
  ChevronRight,
  CircleCheck,
  GitBranch,
  GitFork,
  ScrollText,
  StickyNote,
  Sunrise,
} from '@lucide/solid'
import { createMemo, createSignal, Match, Show, Switch } from 'solid-js'
import { Markdown, MentionText } from '@/components/markdown/markdown.solid.tsx'
import { Button } from '@/components/ui/button.solid.tsx'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible.solid.tsx'
import {
  Card,
  Fold,
  renderEntry,
  cn,
  formatTime,
  ROOT,
  switchConversation,
  useDocOf,
  useTranscript,
  type SolidEntryProps,
  type SolidToolProps,
} from '@/sdk/solid'
import { parseConversationId } from '../../lib/ids.ts'
import { ConversationRef } from '../conversations/ui.solid.tsx'
import { NoteEntry } from '../entries/refs.ts'
import { Open } from '../workspaces/ui.solid.tsx'
import { BranchedEntry } from './entries.ts'
import { AbstractEntry, FinishedEntry, LineageResetEntry, RootsDoc } from './refs.ts'

type BranchRow = { entry: typeof BranchedEntry extends Entry<infer D> ? TypedEntry<D> : never }

export const Branched = renderEntry(BranchedEntry, function BranchedLine(props) {
  const branch = () => props.entry.data.branch
  return (
    <Show when={!props.entry.model} fallback={<Started entry={props.entry} />}>
      <Button
        aria-label={`Open #${branch()} (branched at entry ${props.entry.id})`}
        class="flex w-full min-w-0 items-center gap-3 font-mono text-[11px] font-normal text-muted-foreground/70 before:h-px before:flex-1 before:bg-border/70 after:h-px after:flex-1 after:bg-border/70 hover:text-foreground"
        data-lineage-branched={branch()}
        onClick={() => switchConversation(branch())}
        size={null}
        title={`Open #${branch()}`}
        type="button"
        variant={null}
      >
        <span class="flex max-w-[70%] min-w-0 items-center gap-1.5">
          <GitFork class="size-3 shrink-0" />
          <span class="shrink-0">Branched →</span>
          <ConversationRef id={branch()} title={props.entry.data.intent} />
        </span>
      </Button>
    </Show>
  )
})

export function Woken(_props: SolidEntryProps) {
  return (
    <div
      class="flex items-center gap-3 font-mono text-[11px] text-muted-foreground/70 before:h-px before:flex-1 before:bg-border/70 after:h-px after:flex-1 after:bg-border/70"
      data-lineage-woken="true"
    >
      <span class="flex items-center gap-1.5">
        <Sunrise class="size-3 shrink-0" />
        woke after compaction
      </span>
    </div>
  )
}

function Started(props: BranchRow) {
  const [open, setOpen] = createSignal(false)
  const data = () => props.entry.data
  const date = createMemo(() => {
    const timestamp = props.entry.model?.[0]?.timestamp
    return timestamp === undefined ? undefined : new Date(timestamp)
  })
  return (
    <Card data-lineage-started={data().branch}>
      <header class="flex min-w-0 items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground">
        <GitFork class="size-3.5 shrink-0 text-brand" />
        <span class="shrink-0 text-foreground">Started</span>
        <Button
          aria-label={`Open #${data().branch} (started at entry ${props.entry.id})`}
          class="flex min-w-0 shrink overflow-hidden font-mono text-[11px] font-normal text-foreground hover:underline"
          onClick={() => switchConversation(data().branch)}
          size={null}
          title={`Open #${data().branch}`}
          type="button"
          variant={null}
        >
          <ConversationRef id={data().branch} />
        </Button>
        <Show when={data().from}>
          {(from) => (
            <Button
              aria-label={`Open source #${from()} (started at entry ${props.entry.id})`}
              class="shrink-0 font-mono text-[11px] font-normal hover:text-foreground hover:underline"
              onClick={() => switchConversation(from())}
              size={null}
              title={`Open #${from()}`}
              type="button"
              variant={null}
            >
              from #{from()}/{data().at}
            </Button>
          )}
        </Show>
        <Show when={date()}>
          {(timestamp) => (
            <time
              class="ml-auto shrink-0 tabular-nums"
              datetime={timestamp().toISOString()}
              title={timestamp().toLocaleString()}
            >
              {formatTime(timestamp())}
            </time>
          )}
        </Show>
      </header>
      <Button
        aria-expanded={open() ? 'true' : 'false'}
        aria-label={`Toggle branch intent at entry ${props.entry.id}`}
        class="block h-auto w-full min-w-0 px-3 py-2.5 text-left text-[13px] leading-relaxed font-normal whitespace-normal"
        onClick={() => setOpen((current) => !current)}
        size={null}
        title={open() ? 'Show less' : 'Show more'}
        type="button"
        variant={null}
      >
        <span class={cn('block break-words whitespace-pre-wrap', !open() && 'line-clamp-3')}>
          <MentionText text={data().intent} />
        </span>
        <Show when={data().images}>
          {(images) => (
            <span class="mt-1.5 block font-mono text-[11px] text-muted-foreground">
              {images()} image{images() === 1 ? '' : 's'}
            </span>
          )}
        </Show>
      </Button>
    </Card>
  )
}

export const Abstract = renderEntry(AbstractEntry, function AbstractCard(props) {
  const transcript = useTranscript()
  const abstract = createMemo(() => {
    const entry = props.entry
    if (entry.data.anchor !== undefined) return undefined
    let latest: EntryRecord = entry
    for (const other of transcript())
      if (other.id > latest.id && other.edits?.some((edit) => edit.target === entry.id))
        latest = other
    if (latest.edits?.some((edit) => edit.target === entry.id && edit.action === 'omit'))
      return undefined
    return AbstractEntry.is(latest) ? latest.data : undefined
  })
  return (
    <Show when={abstract()}>
      {(data) => (
        <Fold
          card={props.entry.id}
          label={`Toggle abstract at entry ${props.entry.id}`}
          summary={
            <>
              <ScrollText class="size-3 shrink-0" />
              <span class="shrink-0">Abstract</span>
              <span class="flex min-w-0 text-foreground/80">
                <ConversationRef id={data().conversation} title={data().title} />
              </span>
            </>
          }
        >
          <section
            class="min-w-0 rounded-md border border-border bg-muted/20"
            data-lineage-abstract={data().conversation}
          >
            <header class="flex min-w-0 items-center gap-2 border-b border-border/60 px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
              <ScrollText class="size-3.5 shrink-0" />
              <span class="shrink-0">Abstract ·</span>
              <Button
                aria-label={`Open #${data().conversation} (abstract at entry ${props.entry.id})`}
                class="flex min-w-0 shrink font-mono text-[11px] font-normal text-foreground hover:underline"
                onClick={() => switchConversation(data().conversation)}
                size={null}
                title={`Open #${data().conversation}`}
                type="button"
                variant={null}
              >
                <ConversationRef id={data().conversation} title={data().title} />
              </Button>
              <div class="ml-auto flex shrink-0">
                <Open card={props.entry.id} entry={data().at} id={data().conversation} />
              </div>
            </header>
            <p class="min-w-0 px-3 py-2.5 text-[12.5px] leading-relaxed break-words whitespace-pre-wrap text-muted-foreground">
              <MentionText text={data().text} />
            </p>
          </section>
        </Fold>
      )}
    </Show>
  )
})

export function Finished(props: SolidEntryProps) {
  const data = () => {
    const entry = props.entry
    return FinishedEntry.is(entry) || NoteEntry.is(entry) ? entry.data : undefined
  }
  return (
    <Show when={data()?.from}>
      {(from) => (
        <section
          class="min-w-0 rounded-md border border-l-2 border-border border-l-success/70 bg-muted/20"
          data-lineage-finished={from()}
        >
          <header class="flex min-w-0 items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground">
            <CircleCheck class="size-3.5 shrink-0 text-success" />
            <Button
              aria-label={`Open #${from()} (finished at entry ${props.entry.id})`}
              class="flex min-w-0 shrink items-center gap-1.5 text-left font-mono text-[11px] font-normal text-foreground hover:underline"
              onClick={() => switchConversation(from())}
              size={null}
              title={`Open #${from()}`}
              type="button"
              variant={null}
            >
              <ConversationRef id={from()} title={data()?.title} />
              <span class="shrink-0">finished</span>
            </Button>
          </header>
          <div class="min-w-0 px-3 py-2.5 text-[13px] leading-relaxed">
            <Markdown text={data()?.text ?? ''} />
          </div>
        </section>
      )}
    </Show>
  )
}

function NoteCard(props: {
  label: string
  id?: ConversationId | string
  text: string
  note: 'received' | 'left'
  card: string
}) {
  const conversation = () => (typeof props.id === 'number' ? props.id : undefined)
  return (
    <section
      class="min-w-0 rounded-md border border-l-2 border-note/25 border-l-note/60 bg-note/6"
      data-lineage-note={props.note}
    >
      <header class="flex min-w-0 items-center gap-2 border-b border-note/15 px-3 py-2 font-mono text-[11px] text-foreground">
        <StickyNote class="size-3.5 shrink-0 text-note" />
        {props.label}
        <Show when={conversation()} fallback={props.id}>
          {(id) => (
            <Button
              aria-label={`Open #${id()} (note ${props.card})`}
              class="min-w-0 shrink font-mono text-[11px] font-normal hover:underline"
              onClick={() => switchConversation(id())}
              size={null}
              title={`Open #${id()}`}
              type="button"
              variant={null}
            >
              <ConversationRef id={id()} />
            </Button>
          )}
        </Show>
      </header>
      <div class="min-w-0 px-3 py-2.5 text-[13px] leading-relaxed">
        <Markdown text={props.text} />
      </div>
    </section>
  )
}

export const Note = renderEntry(NoteEntry, function NoteRow(props) {
  const data = () => props.entry.data
  return (
    <Switch
      fallback={
        <NoteCard
          card={`at entry ${props.entry.id}`}
          id={data().from}
          label="Note from"
          note="received"
          text={data().text}
        />
      }
    >
      <Match when={data().source === 'lander'}>{props.core}</Match>
      <Match when={data().source === 'finished'}>
        <Finished entry={props.entry} core={props.core} />
      </Match>
      <Match when={data().source === 'main'}>
        <Catchup text={data().text} />
      </Match>
    </Switch>
  )
})

function Catchup(props: { text: string }) {
  return (
    <Card data-lineage-note="main">
      <header class="flex items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px] text-foreground">
        <GitBranch class="size-3.5 text-brand" />
        Catch-up
      </header>
      <div class="min-w-0 px-3 py-2.5 text-[13px] leading-relaxed">
        <Markdown text={props.text} />
      </div>
    </Card>
  )
}

export function NoteCall(props: SolidToolProps) {
  const destination = () => {
    const left = /^Left a note in #(\d+)\.$/.exec(props.call.output)
    const to = left ? Number(left[1]) : props.call.args.to
    return typeof to === 'number'
      ? parseConversationId(to)
      : typeof to === 'string'
        ? to
        : undefined
  }
  return (
    <Show
      when={props.call.status !== 'error' && props.call.status !== 'interrupted'}
      fallback={props.core}
    >
      <NoteCard
        card={`in call ${props.call.id}`}
        id={destination()}
        label="Note →"
        note="left"
        text={typeof props.call.args.text === 'string' ? props.call.args.text : ''}
      />
    </Show>
  )
}

function userText(entry: EntryRecord) {
  const message = entry.model?.[0]
  if (message?.role !== 'user') return ''
  return typeof message.content === 'string'
    ? message.content
    : message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n')
}

function Genesis(props: { entry: EntryRecord }) {
  const text = createMemo(() => userText(props.entry))
  const from = createMemo(() => {
    const match = /^<tally from="#(\d+)\/(\d+)">/.exec(text())
    return match ? { id: parseConversationId(Number(match[1])), at: Number(match[2]) } : undefined
  })
  const genesis = () =>
    text()
      .replace(/^<tally[^>]*>\n/, '')
      .replace(/\n<\/tally>$/, '')
  return (
    <Collapsible
      class="group/genesis rounded-lg border border-brand/30 bg-brand/5"
      data-lineage-genesis={props.entry.conversationId}
    >
      <CollapsibleTrigger
        aria-label={`Toggle starting context at entry ${props.entry.id}`}
        class="flex w-full flex-col gap-1 px-3.5 py-2.5 text-left"
      >
        <span class="flex items-center gap-1.5 font-mono text-[11px] text-brand">
          <ChevronRight class="size-3.5 transition-transform group-data-open/genesis:rotate-90" />
          Context starts here
          <Show when={from()}>
            {(source) => ` · distilled from #${source().id}/${source().at}`}
          </Show>
        </span>
        <span class="text-xs text-muted-foreground">
          {from() && from()?.id !== props.entry.conversationId
            ? 'The project reading is distilled into the start of this context.'
            : 'The conversation before this point is distilled into the start of the context. Earlier messages remain available above.'}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent class="border-t border-brand/20 px-3.5 py-2.5 text-[13px]">
        <Show when={from()}>
          {(source) => <Open card={props.entry.id} id={source().id} entry={source().at} />}
        </Show>
        <Markdown text={genesis()} />
      </CollapsibleContent>
    </Collapsible>
  )
}

export function Reset(props: SolidEntryProps) {
  const roots = useDocOf(() => ROOT, RootsDoc)
  const tally = () => LineageResetEntry.is(props.entry) && props.entry.data?.lineage?.tally
  const bareRootReset = () =>
    !props.entry.model &&
    props.entry.data === undefined &&
    roots()?.roots.includes(props.entry.conversationId)
  return (
    <Switch fallback={props.core}>
      <Match when={tally()}>
        <Genesis entry={props.entry} />
      </Match>
      <Match when={bareRootReset()}>{null}</Match>
    </Switch>
  )
}
