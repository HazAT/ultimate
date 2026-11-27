import type { ConversationId, EntryId } from '@earendil-works/pi-durable'
import { ArrowDown } from '@lucide/solid'
import { cn } from 'cn'
import { createEffect, createMemo, createSignal, For, Match, Show, Switch } from 'solid-js'

import { Shimmer } from '@/components/ai/shimmer.solid.tsx'
import { Button } from '@/components/ui/button.solid.tsx'
import {
  createTranscriptFrame,
  EmptyTranscript,
  Transcript as TranscriptScope,
  useCompact,
  useConversation,
  useEvent,
  useStore,
} from '../sdk/hooks.ts'
import { RenderedPoint, Slot } from '../sdk/contribution.solid.tsx'
import {
  compactRows,
  groupAside,
  groupBetween,
  isOpenIn,
  openIn,
  runOf,
  setAsideIds,
} from './compact.ts'
import type { AsideGroup, BetweenGroup, CompactPart, WorkRun } from './compact.ts'
import { ContributionError } from './contribution-error.solid.tsx'
import { EmptyState } from './empty-state.solid.tsx'
import { AssistantView, EntryView } from './entry.solid.tsx'
import { reportedFailure } from './error-stack.solid.tsx'
import { createHistory } from './history.solid.tsx'
import { column } from './layout.ts'
import { LiveStatus } from './live-status.solid.tsx'
import { indexTools, partialOf, slotsOf, toolCallId } from './model.ts'
import {
  AsideFold,
  asideFirstEntryKey,
  BetweenLine,
  itemKey,
  itemParts,
  readBetween,
  recedeRow,
  shownCalls,
  shownKey,
  WorkRow,
  writeBetween,
} from './transcript-folds.solid.tsx'
import type { Item, Row, Shown } from './transcript-folds.solid.tsx'
import { createScrollKeeper, reducedMotion } from './transcript-scroll.ts'
import { TranscriptSkeleton } from './transcript-skeleton.solid.tsx'

export function Transcript(props: { dock?: boolean }) {
  const conversation = useConversation()
  const id = createMemo(() => conversation().id)
  const loading = createMemo(() => conversation().loading)
  return (
    <div class="relative flex min-h-0 flex-1 flex-col">
      <For each={[id()]}>
        {(shown) => <TranscriptView dock={props.dock} initialId={shown} loading={loading()} />}
      </For>
      <SkeletonUntilLoaded dock={props.dock} loading={loading()} />
    </div>
  )
}

function SkeletonUntilLoaded(props: { dock?: boolean; loading: boolean }) {
  const requested = useStore((state) => state.requested)
  const conversations = useStore((state) => state.conversations)
  const hasPriorMessages = createMemo(() => {
    const shown = conversations().find((row) => row.id === requested())
    return shown?.inputAt !== undefined || shown?.answerAt !== undefined
  })
  const [shown, setShown] = createSignal(false)
  createEffect(
    () => props.loading && hasPriorMessages(),
    (placeholder) => {
      if (placeholder) setShown(true)
    },
  )
  let skeleton: HTMLDivElement | undefined
  createEffect(
    () => !props.loading && shown(),
    (fading) => {
      if (!fading) return undefined
      if (!skeleton || reducedMotion()) {
        setShown(false)
        return undefined
      }
      const fade = skeleton.animate([{ opacity: 0 }], {
        duration: 300,
        easing: 'ease-out',
        fill: 'forwards',
      })
      fade.finished.then(
        () => setShown(false),
        () => {},
      )
      return () => fade.cancel()
    },
  )
  return (
    <Show when={shown()}>
      <TranscriptSkeleton
        dock={props.dock}
        ref={(element) => {
          skeleton = element
        }}
      />
    </Show>
  )
}

function TranscriptView(props: {
  dock?: boolean
  loading: boolean
  initialId: ConversationId | undefined
}) {
  const conversation = useConversation()
  const id = props.initialId
  const busy = createMemo(() => conversation().busy)
  const live = createMemo(() => conversation().live)
  const history = createHistory(
    id,
    createMemo(() => conversation().entries),
    createMemo(() => conversation().older),
  )
  const transcript = createTranscriptFrame(history.entries)

  const keeper = createScrollKeeper({
    id,
    history,
    loading: () => props.loading,
    transcript,
  })
  const hasRows = () => history.entries().length > 0

  const indexed = createMemo(() => indexTools(history.entries()))
  const results = () => indexed().results
  const tools = createMemo(() => live().tools)
  const slots = createMemo(() => slotsOf(tools()))
  const partial = createMemo(() => partialOf(live()))
  const visible = createMemo(() =>
    history
      .entries()
      .filter(
        (entry) =>
          entry.conversationId === id &&
          !(entry.kind === 'pi.tool-result' && indexed().calls.has(toolCallId(entry) ?? '')),
      ),
  )
  const compact = useCompact()
  const rows = createMemo((): Row[] => {
    const folding = compact()
    return folding
      ? compactRows(visible(), (call) => folding.keeps(call))
      : visible().map((entry) => ({ entry }))
  })
  const aside = createMemo(() => setAsideIds(history.entries()))
  const grouped = createMemo(() => groupAside(rows(), aside()))
  const threaded = createMemo((): Shown[] => {
    const thread = compact()?.thread
    return thread
      ? groupBetween(
          grouped(),
          (row) =>
            !('work' in row || 'aside' in row) &&
            thread({ entry: row.entry, calls: shownCalls(row) }),
        )
      : grouped()
  })

  const [shownBetween, setShownBetween] = createSignal(0)
  const [shownAside, setShownAside] = createSignal<ReadonlySet<number>>(new Set())
  const [openedParts, setOpenedParts] = createSignal<ReadonlySet<string>>(new Set())
  const isOpen = (run: WorkRun) => isOpenIn(openedParts(), run)
  const open = (run: WorkRun, value: boolean) => setOpenedParts((keys) => openIn(keys, run, value))
  const betweenOpen = (group: BetweenGroup<Item>) => {
    shownBetween()
    return readBetween(id, group)
  }
  const setBetween = (group: BetweenGroup<Item>, value: boolean) => {
    writeBetween(id, group, value)
    setShownBetween((count) => count + 1)
  }

  const [reveal, setReveal] = createSignal<{ entry: EntryId; call?: string }>()
  useEvent('ultimate:reveal-entry', (value) => {
    const target = value as
      | {
          conversationId?: ConversationId
          entryId?: EntryId
          toolCallId?: string
        }
      | undefined
    const entryId = target?.entryId
    if (target?.conversationId === id && entryId !== undefined && Number.isSafeInteger(entryId))
      setReveal({ entry: entryId, call: target?.toolCallId })
  })
  createEffect(
    () => ({
      target: reveal(),
      waiting: props.loading || history.pending() || !keeper.placed(),
      error: history.error(),
      entries: history.entries(),
      filling: history.filling(),
      threaded: threaded(),
      opened: openedParts(),
      aside: shownAside(),
      between: shownBetween(),
    }),
    ({ target, waiting, error, entries, filling }) => {
      if (target === undefined || waiting) return
      if (error) {
        setReveal(undefined)
        return
      }
      const { entry: revealed, call } = target
      if (!entries.some((entry) => entry.id === revealed)) {
        const cursor = history.cursor()
        if (cursor !== undefined && revealed < cursor) {
          void history.loadDown(revealed, keeper.stop)
          return
        }
        if (filling) return
      }
      const between = threaded().find(
        (row): row is BetweenGroup<Item> =>
          'between' in row &&
          row.between.some((inner) => itemParts(inner).some((part) => part.entry.id === revealed)),
      )
      if (between && !readBetween(id, between)) {
        setBetween(between, true)
        return
      }
      const group = grouped().find(
        (row): row is AsideGroup => 'aside' in row && !!runOf(row.aside, revealed),
      )
      const first = group && asideFirstEntryKey(group)
      if (first !== undefined && !shownAside().has(first)) {
        setShownAside((keys) => new Set(keys).add(first))
        return
      }
      const run = compact() && runOf(rows(), revealed)
      if (run && !isOpen(run)) {
        open(run, true)
        return
      }
      const row = `[data-entry-id="${revealed}"]`
      const block =
        call === undefined
          ? undefined
          : keeper.content().querySelector(`${row} [data-tool-call-id="${CSS.escape(call)}"]`)
      const element =
        block && block.getBoundingClientRect().height > 0
          ? block
          : keeper.content().querySelector(row)
      if (element) keeper.holdInView(element)
      setReveal(undefined)
    },
  )

  const RowView = (row: { row: Row; last: boolean; faded?: string }) => (
    <Show
      when={'work' in row.row ? row.row : undefined}
      fallback={
        <div
          class={cn('empty-row', row.faded)}
          data-conversation-id={id}
          data-entry-id={(row.row as CompactPart).entry.id}
        >
          <EntryView
            blocks={(row.row as CompactPart).blocks}
            busy={busy()}
            entry={(row.row as CompactPart).entry}
            results={results()}
            slots={slots()}
          />
        </div>
      }
    >
      {(run) => (
        <div
          class={cn('empty-row', row.faded)}
          data-conversation-id={id}
          data-entry-id={run().work[0].entry.id}
          data-run-last={run().work.at(-1)!.entry.id}
        >
          <WorkRow
            busy={busy()}
            onOpenChange={(value) => open(run(), value)}
            open={isOpen(run())}
            results={results()}
            run={run()}
            slots={slots()}
            working={busy() && row.last}
          />
        </div>
      )}
    </Show>
  )
  const ItemView = (item: { item: Item; last: boolean; faded?: string }) => (
    <Show
      when={'aside' in item.item ? item.item : undefined}
      fallback={<RowView faded={item.faded} last={item.last} row={item.item as Row} />}
    >
      {(group) => {
        const key = () => asideFirstEntryKey(group())
        return (
          <AsideFold
            faded={item.faded}
            group={group()}
            onOpenChange={(value) =>
              setShownAside((keys) => {
                const next = new Set(keys)
                if (value) next.add(key())
                else next.delete(key())
                return next
              })
            }
            open={shownAside().has(key())}
            Row={(inner) => <RowView last={false} row={inner.row} />}
          />
        )
      }}
    </Show>
  )

  return (
    <TranscriptScope value={transcript.frame}>
      <div class="relative min-h-0 flex-1 overflow-y-hidden" role="log">
        <div
          class="h-full w-full overflow-y-auto md:[scrollbar-gutter:stable_both-edges]"
          ref={keeper.refs.scroll}
        >
          <div
            class={cn(column(props.dock), 'flex flex-col gap-3 pt-6 pb-10')}
            data-ui="transcript"
            ref={keeper.refs.content}
          >
            <div class="pointer-events-none sticky top-0 z-10 -mb-3 h-0 [overflow-anchor:none]">
              <div ref={keeper.refs.pinned}>
                <Slot
                  fallback={(extension, error, trace) => (
                    <div class="pointer-events-auto">
                      {reportedFailure(extension, error, trace)}
                    </div>
                  )}
                  name="transcript.top"
                />
              </div>
            </div>
            <Show when={!props.loading && hasRows() && history.cursor() !== undefined}>
              <div
                class="flex min-h-5 items-center justify-center font-mono text-[11px] text-muted-foreground/70"
                ref={keeper.refs.sentinel}
              >
                <Switch>
                  <Match when={history.pending()}>
                    <Shimmer>loading earlier messages…</Shimmer>
                  </Match>
                  <Match when={history.error()}>
                    <span class="flex items-center gap-2" role="alert">
                      <span class="text-error">Could not load earlier messages</span>
                      <Button
                        class="h-6 px-2 font-mono text-[11px]"
                        onClick={history.retry}
                        size="sm"
                        variant="ghost"
                      >
                        Retry
                      </Button>
                    </span>
                  </Match>
                </Switch>
              </div>
            </Show>
            <Show when={!props.loading && visible().length === 0 && !partial()}>
              <Show when={id !== undefined} fallback={<EmptyState />}>
                <RenderedPoint
                  core={() => <EmptyState />}
                  fallback={(extension, error, inner) => (
                    <ContributionError error={error} extension={extension} inline>
                      {inner()}
                    </ContributionError>
                  )}
                  input={{ conversation: id! }}
                  point={EmptyTranscript}
                />
              </Show>
            </Show>
            <Show when={!props.loading && visible().length > 0 && history.cursor() === undefined}>
              <Slot fallback={reportedFailure} name="transcript.start" />
            </Show>
            <For each={threaded()} keyed={shownKey}>
              {(item, index) => {
                const last = () => index() === threaded().length - 1
                return (
                  <Show
                    when={'between' in item() ? (item() as BetweenGroup<Item>) : undefined}
                    fallback={<ItemView item={item() as Item} last={last()} />}
                  >
                    {(group) => {
                      const shown = () => (busy() && last()) || betweenOpen(group())
                      return (
                        <>
                          <BetweenLine
                            group={group()}
                            onOpen={() => setBetween(group(), !shown())}
                            open={shown()}
                            summary={compact()?.summary}
                            working={busy() && last()}
                          />
                          <Show when={shown()}>
                            <For each={group().between} keyed={itemKey}>
                              {(inner, inside) => (
                                <ItemView
                                  faded={recedeRow}
                                  item={inner()}
                                  last={last() && inside() === group().between.length - 1}
                                />
                              )}
                            </For>
                            <Show when={!last()}>
                              <div aria-hidden="true" class="my-1 h-px bg-border/50" />
                            </Show>
                          </Show>
                        </>
                      )
                    }}
                  </Show>
                )
              }}
            </For>
            <Show when={partial()}>
              {(message) => (
                <AssistantView
                  busy
                  message={message()}
                  results={results()}
                  slots={slots()}
                  streaming
                />
              )}
            </Show>
            <Slot fallback={reportedFailure} name="transcript.end" />
            <LiveStatus busy={busy()} id={id} live={live()} partial={partial()} />
            <div
              aria-hidden="true"
              class="-mt-3 shrink-0"
              data-history-anchor-space
              ref={keeper.refs.tail}
            />
          </div>
        </div>
        <Show when={!keeper.following()}>
          <Button
            aria-label="Scroll to bottom"
            class="absolute bottom-3 left-1/2 size-7 -translate-x-1/2 rounded-full bg-popover shadow-md"
            onClick={() => keeper.toEnd()}
            size="icon"
            variant="outline"
          >
            <ArrowDown aria-hidden="true" class="size-3.5" />
          </Button>
        </Show>
      </div>
    </TranscriptScope>
  )
}
