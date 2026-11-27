import type { ConversationId } from '@earendil-works/pi-durable'
import { Search, X } from '@lucide/solid'
import { createEffect, createMemo, createSignal, For, onCleanup, Show, untrack } from 'solid-js'
import type { Accessor } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible.solid.tsx'
import { Toggle } from '@/components/ui/toggle.solid.tsx'
import { Input } from '@/components/ui/input.solid.tsx'
import { SegmentedControl, SegmentedControlItem } from '@/components/ui/segmented-control.solid.tsx'
import {
  api,
  cn,
  errorMessage,
  formatDuration,
  keepLast,
  showSurface,
  switchConversation,
  ROOT,
  useAction,
  writingAs,
} from '@/sdk/solid'
import { deadline } from '../../lib/timers.shared.ts'
import { ConversationRef } from '../conversations/ui.solid.tsx'
import {
  asking,
  empty,
  failed,
  followed,
  loaded,
  older,
  pagesOlder,
  wantOlder,
} from './feed.web.ts'
import type { Feed } from './feed.web.ts'
import { StreamAction } from './refs.ts'
import type { SystemFilter, SystemRow } from './refs.ts'
import { clock, KindIcon, TraceTree } from './tree.solid.tsx'

const sources = {
  all: {},
  events: { sources: ['event'] },
  tools: { kinds: ['tool'] },
  model: { kinds: ['model'] },
  actions: { kinds: ['action'] },
  services: { kinds: ['service'] },
  reactors: { kinds: ['reactor'] },
} satisfies Record<string, SystemFilter>

type Source = keyof typeof sources
const sourceNames = Object.keys(sources) as Source[]
export type StreamView = {
  source: Source
  errors: boolean
  conversation?: ConversationId
  text: string
}

const ownPoll = (row: SystemRow) =>
  row.kind === 'action' &&
  (row.name === 'system/stream' || row.name === 'system/lanes') &&
  row.summary.startsWith('ui →')

const pollMs = 2000
const pageSize = 100

type Page = Awaited<NonNullable<typeof StreamAction.result>>

function useStream(filter: Accessor<SystemFilter>, live: Accessor<boolean>) {
  const [state, setState] = createSignal(empty)
  const controller = new AbortController()
  onCleanup(() => controller.abort())
  let target: Page | undefined
  const request = (
    cursor: { before?: string; after?: string },
    step: (feed: Feed, page: Page) => Feed,
  ) => {
    setState(asking)
    const chasing = target
    void api
      .action(
        StreamAction,
        { ...filter(), ...cursor, limit: pageSize },
        { signal: controller.signal },
      )
      .then(
        (page) => {
          if (controller.signal.aborted) return
          const stepped = step(state(), page)
          const drained = cursor.after !== undefined && page.rows.length < pageSize
          if (drained && target === chasing && stepped.head !== undefined) target = undefined
          setState(stepped)
          catchUp(stepped)
        },
        (error: unknown) => {
          if (!controller.signal.aborted)
            setState((previous) => failed(previous, errorMessage(error)))
        },
      )
  }
  function catchUp(current = state()) {
    const newestPage = target
    const { head, loading } = current
    if (!newestPage || head === newestPage.head) return
    if (head === undefined) setState((previous) => loaded(previous, newestPage))
    else if (!loading) request({ after: head }, (feed, page) => followed(feed, head, page))
  }
  const newest = useAction(
    StreamAction,
    { ...untrack(filter), limit: pageSize },
    { conversation: ROOT, onError: keepLast, every: () => (live() ? pollMs : undefined) },
  )
  createEffect(
    () => newest.data(),
    (page) => {
      target = page
      catchUp()
    },
  )
  createEffect(
    () => newest.error(),
    (error) => {
      if (error) setState((previous) => failed(previous, errorMessage(error)))
    },
  )
  const next = createMemo(() => (pagesOlder(state()) ? state().next : undefined))
  createEffect(next, (cursor) => {
    if (cursor !== undefined) request({ before: cursor }, (feed, page) => older(feed, cursor, page))
  })
  return { state, more: () => setState(wantOlder) }
}

function Row(props: { row: SystemRow }) {
  const row = () => props.row
  return (
    <Collapsible data-row={row().id} disabled={!row().trace} render={(item) => <li {...item} />}>
      <div class="flex min-w-0 items-start gap-1.5 px-3 py-[3px] font-mono text-[10.5px] leading-[18px] text-muted-foreground hover:bg-muted/40 pointer-coarse:py-1.5">
        <CollapsibleTrigger
          aria-label={`${row().name} · event or call ${row().id}`}
          disabled={!row().trace}
          class="inline-flex w-auto min-w-0 flex-1 items-start justify-start gap-1.5 rounded-md text-left text-[length:inherit] leading-[inherit] font-normal whitespace-nowrap outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none"
          title={row().summary}
        >
          <time class="w-14 shrink-0 tabular-nums text-muted-foreground/60" datetime={row().at}>
            {clock(row().at)}
          </time>
          <KindIcon kind={row().kind} ok={row().ok} />
          <span
            class={cn(
              'min-w-0 truncate md:shrink-0',
              row().ok ? 'text-foreground/85' : 'text-error',
            )}
          >
            {row().name}
          </span>
          <span class="min-w-0 flex-1 truncate text-muted-foreground/70 max-md:hidden">
            {row().error ?? row().summary}
          </span>
        </CollapsibleTrigger>
        <Show when={row().conversation}>
          {(id) => (
            <Button
              aria-label={`Open #${id()} from event or call ${row().id}`}
              size={null}
              variant={null}
              class="min-w-0 max-w-[40%] shrink justify-start rounded-sm font-sans text-[11px] font-normal text-foreground/75 hover:text-foreground md:max-w-64"
              onClick={() => {
                showSurface('agent')
                switchConversation(id())
              }}
              title={`Open #${id()}`}
            >
              <ConversationRef id={id()} />
            </Button>
          )}
        </Show>
        <span class="w-12 shrink-0 text-right tabular-nums">
          {row().ms === undefined ? '' : formatDuration(row().ms!)}
        </span>
      </div>
      <Show when={!row().ok && row().error}>
        <p class="truncate px-3 pb-0.5 pl-[5.5rem] font-mono text-[10.5px] text-error/90 md:hidden">
          {row().error}
        </p>
      </Show>
      <CollapsibleContent>
        <Show when={row().trace} keyed>
          {(trace) => <TraceTree trace={trace} />}
        </Show>
      </CollapsibleContent>
    </Collapsible>
  )
}

const chip =
  'h-6 shrink-0 rounded-md px-2 font-mono text-[10.5px] transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ring'

type ViewProps = { view: StreamView; setView: (view: StreamView) => void }

function Filters(props: ViewProps) {
  const update = (changes: Partial<StreamView>) => props.setView({ ...props.view, ...changes })
  const typed = (text: string) => {
    const write = () => update({ text })
    writingAs('app', write)
  }
  return (
    <div class="flex flex-wrap items-center gap-1 px-3 py-2">
      <SegmentedControl
        aria-label="Event source"
        bind={[() => props.view.source, (source) => update({ source })]}
        class="min-w-0 shrink flex-wrap gap-1 border-0 p-0"
      >
        <For each={sourceNames}>
          {(source) => (
            <SegmentedControlItem class={cn(chip, 'hover:bg-accent/60')} value={source}>
              {source}
            </SegmentedControlItem>
          )}
        </For>
      </SegmentedControl>
      <Toggle
        pressed={props.view.errors}
        size={null}
        variant={null}
        class={cn(
          chip,
          'font-normal text-muted-foreground hover:bg-accent/60 data-pressed:bg-error/15 data-pressed:text-error',
        )}
        onPressedChange={(errors) => update({ errors })}
      >
        errors only
      </Toggle>
      <Show when={props.view.conversation}>
        {(id) => (
          <Button
            aria-label="Show every conversation"
            size={null}
            variant={null}
            class={cn(chip, 'gap-1 bg-accent font-normal text-foreground')}
            onClick={() => update({ conversation: undefined })}
            title="Show every conversation"
          >
            <ConversationRef class="max-w-48 font-sans text-[11px]" id={id()} />{' '}
            <X class="size-3" />
          </Button>
        )}
      </Show>
      <div class="ml-auto flex h-6 min-w-0 items-center gap-1.5 rounded-md border border-border/70 px-2 max-md:w-full md:w-56">
        <Search class="size-3 shrink-0 text-muted-foreground" />
        <Input
          aria-label="Filter event text"
          class="h-auto min-w-0 flex-1 rounded-none border-0 bg-transparent p-0 font-mono text-[11px] shadow-none focus-visible:ring-0 placeholder:text-muted-foreground/60"
          onValueChange={typed}
          placeholder="filter text"
          value={props.view.text}
        />
      </div>
    </div>
  )
}

export function Stream(props: ViewProps & { live: boolean }) {
  const [text, setText] = createSignal(() => props.view.text.trim())
  createEffect(
    () => props.view.text.trim(),
    (value) => deadline(300, () => setText(value)),
  )
  const key = createMemo(() =>
    JSON.stringify({
      ...sources[props.view.source],
      ...(props.view.errors ? { errors: true } : {}),
      ...(props.view.conversation === undefined ? {} : { conversation: props.view.conversation }),
      ...(text() ? { text: text() } : {}),
    }),
  )
  return (
    <>
      <Filters setView={props.setView} view={props.view} />
      <Show when={key()} keyed>
        {(filter) => <FeedRows filter={JSON.parse(filter) as SystemFilter} live={props.live} />}
      </Show>
    </>
  )
}

function FeedRows(props: { filter: SystemFilter; live: boolean }) {
  const { state, more } = useStream(
    () => props.filter,
    () => props.live,
  )
  const rows = createMemo(() => state().rows.filter((row) => !ownPoll(row)))
  let end!: HTMLDivElement
  createEffect(
    () => ({ length: state().rows.length, error: state().error }),
    ({ error }) => {
      const observer = new IntersectionObserver((seen) => {
        if (seen.some((entry) => entry.isIntersecting)) more()
      })
      const cancel = deadline(error ? pollMs : 0, () => observer.observe(end))
      return () => {
        cancel()
        observer.disconnect()
      }
    },
  )
  return (
    <>
      <ul class="flex flex-col">
        <For each={rows()} keyed={(row) => row.id}>
          {(row) => <Row row={row()} />}
        </For>
      </ul>
      <div class="px-3 py-4 text-center font-mono text-[11px] text-muted-foreground/70" ref={end}>
        <Show
          when={state().error}
          fallback={
            state().rows.length === 0
              ? state().loading
                ? 'loading…'
                : 'nothing matches'
              : state().next === undefined
                ? 'the start of the record'
                : ''
          }
        >
          {(error) => (
            <span class="text-error/90" data-stream-error>
              couldn’t load: {error()} · retrying
            </span>
          )}
        </Show>
      </div>
    </>
  )
}
