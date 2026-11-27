import type { ConversationId } from '@earendil-works/pi-durable'
import { Brain, Search, Trash2 } from '@lucide/solid'
import { For, Show, createEffect, createMemo, createSignal } from 'solid-js'
import { Markdown } from '@/components/markdown/markdown.solid.tsx'
import { Button } from '@/components/ui/button.solid.tsx'
import { Input } from '@/components/ui/input.solid.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.solid.tsx'
import {
  Header,
  Provided,
  Sidebar,
  StatusLine,
  api,
  cn,
  column,
  defineWebExtension,
  errorMessage,
  events,
  formatAgo,
  formatTokens,
  notify,
  provide,
  showSurface,
  switchConversation,
  useDocOf,
  useNow,
  useUiState,
  writingAs,
} from '@/sdk/solid'
import { parseConversationId, parseEntryId } from '../../lib/ids.shared.ts'
import { ConversationRef, Unsummarized } from '../conversations/ui.solid.tsx'
import { RootComposer } from './banner.solid.tsx'
import { MemoryCall, NotifyCall, RememberCall } from './calls.solid.tsx'
import { ForgetAction, MemoryDoc, TallyDoc } from './refs.ts'
import type { MemoryItem } from './refs.ts'
import { GoBackAction, Rewound, RewoundDependent } from './rewind.solid.tsx'
import { Abstract, Branched, Finished, Note, NoteCall, Reset, Woken } from './rows.solid.tsx'
import { MEMORY_FOCUS, MEMORY_SURFACE, MemoryHeader, useRoots } from './ui.solid.tsx'

function MemorySource(props: { root: ConversationId; source: string; slug: string }) {
  const parsed = createMemo(() => {
    const [conversation, entry] = props.source.slice(1).split('/')
    return {
      conversation: parseConversationId(Number(conversation)),
      entry: entry === undefined ? undefined : parseEntryId(Number(entry)),
    }
  })
  return (
    <p class="mt-1 flex min-w-0 items-center gap-1 font-mono text-[10.5px] text-muted-foreground/70">
      <span class="shrink-0">learned in</span>
      <Button
        aria-label={`Open source ${props.source} for memory ${props.slug} in #${props.root}`}
        class="flex min-w-0 shrink items-center rounded-sm px-0.5 text-[11px] font-normal text-foreground hover:bg-accent"
        data-memory-source={props.source}
        onClick={() => {
          const { conversation, entry } = parsed()
          if (entry !== undefined) events.emit('messages:open', { conversation, entry })
          showSurface('agent')
          switchConversation(conversation)
        }}
        size={null}
        title={`Open ${props.source}`}
        variant={null}
      >
        <ConversationRef class="gap-1" id={parsed().conversation} />
        <Show when={parsed().entry !== undefined}>
          <span class="shrink-0 text-muted-foreground/70">/{parsed().entry}</span>
        </Show>
      </Button>
    </p>
  )
}

function MemoryRow(props: { root: ConversationId; slug: string; item: MemoryItem; now: number }) {
  const [open, setOpen] = createSignal(false)
  const [requestedMemorySlug, consumeMemoryFocusRequest] = useUiState<string | null>(
    MEMORY_FOCUS,
    null,
  )
  let row: HTMLLIElement | undefined
  createEffect(
    () => requestedMemorySlug() === props.slug,
    (requested) => {
      if (!requested) return
      setOpen(true)
      row?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      writingAs('app', () => consumeMemoryFocusRequest(null))
    },
  )
  return (
    <li
      class="group/memory min-w-0 rounded-md hover:bg-muted/40"
      data-memory={props.slug}
      ref={row}
    >
      <div class="flex min-w-0 items-start">
        <Button
          aria-expanded={open() ? 'true' : 'false'}
          aria-label={`Show memory ${props.slug} in #${props.root}`}
          class="flex min-w-0 flex-1 shrink flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left font-normal whitespace-normal outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onClick={() => setOpen((current) => !current)}
          size={null}
          title={open() ? 'Show less' : 'Show the memory'}
          variant={null}
        >
          <span class="flex w-full min-w-0 items-center gap-1.5 font-mono text-[10.5px] leading-4 text-muted-foreground">
            <span class="min-w-0 truncate">{props.slug}</span>
            <span
              class="ml-auto shrink-0 pl-1 text-muted-foreground/60"
              title={new Date(props.item.updated).toLocaleString()}
            >
              {formatAgo(props.item.updated, props.now)}
            </span>
          </span>
          <span
            class={cn(
              'block text-[13px] leading-snug break-words text-foreground/90',
              !open() && 'line-clamp-2',
            )}
          >
            {props.item.line}
          </span>
        </Button>
        <Tooltip delay={400}>
          <TooltipTrigger
            aria-label={`Forget ${props.slug} from #${props.root}`}
            class="invisible mt-1.5 mr-1 flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground/70 outline-none group-focus-within/memory:visible group-hover/memory:visible pointer-coarse:visible hover:bg-muted hover:text-error focus-visible:ring-1 focus-visible:ring-ring data-pending:opacity-50"
            onClick={() =>
              api
                .action(ForgetAction, { root: props.root, slug: props.slug })
                .catch((error: unknown) => {
                  notify({ level: 'error', message: errorMessage(error) })
                })
            }
            render={(trigger) => (
              <Button {...trigger} size={null} variant={null}>
                <Trash2 class="size-3.5" />
              </Button>
            )}
          />
          <TooltipContent class="font-mono text-[11px]" side="left">
            Forget this memory
          </TooltipContent>
        </Tooltip>
      </div>
      <Show when={open()}>
        <div class="min-w-0 px-2 pb-3">
          <div class="min-w-0 text-[13px] leading-relaxed text-muted-foreground">
            <Markdown text={props.item.body} />
          </div>
          <Show when={props.item.source}>
            {(source) => <MemorySource root={props.root} slug={props.slug} source={source()} />}
          </Show>
        </div>
      </Show>
    </li>
  )
}

const kindSections = [
  ['decision', 'Decisions'],
  ['fact', 'Facts'],
  ['lesson', 'Lessons'],
] as const

const kindDots: Record<MemoryItem['kind'], string> = {
  decision: 'bg-brand',
  fact: 'bg-muted-foreground/60',
  lesson: 'bg-amber-500',
}

function MemorySurface() {
  const roots = useRoots()
  const [filter, setFilter] = createSignal('')
  return (
    <>
      <div class="flex min-h-0 flex-1">
        <Sidebar />
        <main class="flex min-w-0 flex-1 flex-col">
          <Header>
            <span class="flex shrink-0 items-center gap-2 text-[13px] font-medium">
              <Brain class="size-4 text-muted-foreground" />
              Memory
            </span>
          </Header>
          <div class="min-h-0 flex-1 overflow-y-auto" data-lineage-memory-surface>
            <div class={cn(column(), 'pt-4 pb-10')}>
              <div class="[&>*]:px-0">
                <Provided input={{}} last point={MemoryHeader} />
              </div>
              <For each={roots()}>
                {(root, index) => (
                  <RootMemory
                    filter={filter()}
                    label={(roots()?.length ?? 0) > 1}
                    root={root}
                    setFilter={index() === 0 ? setFilter : undefined}
                  />
                )}
              </For>
            </div>
          </div>
        </main>
      </div>
      <StatusLine />
    </>
  )
}

function RootMemory(props: {
  root: ConversationId
  label: boolean
  filter: string
  setFilter?: (text: string) => void
}) {
  const needle = createMemo(() => props.filter.trim().toLowerCase())
  const memory = useDocOf(() => props.root, MemoryDoc)
  const memories = () => memory()?.memories
  const item = (slug: string) => memories()![slug]
  const tally = useDocOf(() => props.root, TallyDoc)
  const now = useNow(60_000)
  const slugs = createMemo(() =>
    Object.keys(memories() ?? {}).toSorted(
      (a, b) => item(b).updated - item(a).updated || a.localeCompare(b),
    ),
  )
  const matches = createMemo(() =>
    slugs().filter(
      (slug) =>
        !needle() ||
        [slug, item(slug).line, item(slug).body].some((text) =>
          text.toLowerCase().includes(needle()),
        ),
    ),
  )
  return (
    <section data-lineage-memory={props.root}>
      <Show when={props.label}>
        <p class="pt-4 font-mono text-[11px] text-foreground">#{props.root}</p>
      </Show>
      <Show
        when={slugs().length > 0}
        fallback={
          <p class="py-8 text-[12.5px] text-muted-foreground">
            No memories yet. @ultimate keeps decisions, facts and lessons here as branches land.
          </p>
        }
      >
        <div class="flex flex-wrap items-center gap-x-3 gap-y-2 pt-3">
          <p class="min-w-0 font-mono text-[10.5px] text-muted-foreground">
            {needle() ? `${matches().length} of ${slugs().length}` : slugs().length} memories
            <Show when={tally()?.briefTokens !== undefined}>
              <span title="Tokens every new branch starts from">
                {' · '}
                {formatTokens(tally()!.briefTokens!)} tokens
              </span>
            </Show>
          </p>
          <Show when={props.setFilter}>
            {(setFilter) => (
              <label class="ml-auto flex h-7 min-w-0 items-center gap-1.5 rounded-md border border-border/70 px-2 focus-within:border-ring max-sm:w-full sm:w-56">
                <Search class="size-3 shrink-0 text-muted-foreground" />
                <Input
                  aria-label="Filter memories"
                  class="h-auto w-auto min-w-0 flex-1 rounded-none border-0 bg-transparent p-0 font-mono text-[11px] outline-none placeholder:text-muted-foreground/60 focus-visible:ring-0"
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') setFilter()('')
                  }}
                  onValueChange={(value) => setFilter()(value)}
                  placeholder="filter"
                  value={props.filter}
                />
              </label>
            )}
          </Show>
        </div>
        <Show when={matches().length === 0}>
          <p class="py-8 font-mono text-[11.5px] text-muted-foreground/70">
            No memory mentions “{props.filter.trim()}”.
          </p>
        </Show>
        <For each={kindSections}>
          {([kind, title]) => {
            const shown = createMemo(() => matches().filter((slug) => item(slug).kind === kind))
            return (
              <Show when={shown().length > 0}>
                <div class="mt-6" data-memory-kind={kind}>
                  <h3 class="flex items-center gap-1.5 border-b border-border/60 pb-1.5 section-label">
                    <span class={cn('size-1.5 rounded-full', kindDots[kind])} />
                    {title}
                    <span class="text-muted-foreground/60">{shown().length}</span>
                  </h3>
                  <ul class="-mx-2 flex flex-col pt-1">
                    <For each={shown()}>
                      {(slug) => (
                        <MemoryRow item={item(slug)} now={now()} root={props.root} slug={slug} />
                      )}
                    </For>
                  </ul>
                </div>
              </Show>
            )
          }}
        </For>
      </Show>
    </section>
  )
}

const MEMORY_AFTER_REVIEW_ORDER = 70
function StreamRootsForCommands() {
  useRoots()
  return null
}

export default defineWebExtension({
  tools: { note: NoteCall, notify: NotifyCall, memory: MemoryCall, remember: RememberCall },
  entries: {
    'lineage.branched': Branched,
    'lineage.note': Note,
    'lineage.finished': Finished,
    'lineage.woken': Woken,
    'lineage.abstract': Abstract,
    'lineage.rewound': Rewound,
    'lineage.rewound-dependent': RewoundDependent,
    'pi.reset': Reset,
  },
  messageActions: [GoBackAction],
  composer: RootComposer,
  surfaces: [
    {
      id: MEMORY_SURFACE,
      title: 'Memory',
      icon: Brain,
      description: 'What every new branch starts from: decisions, facts and lessons',
      order: MEMORY_AFTER_REVIEW_ORDER,
      component: MemorySurface,
    },
  ],
  slots: { overlay: [StreamRootsForCommands] },
  provides: [
    provide(Unsummarized, (id) => {
      const roots = useRoots()
      return () => roots()?.includes(id()) ?? false
    }),
  ],
})
