import { parseEntryId } from '../../../lib/ids.ts'
import { CompactionEntry } from '@earendil-works/pi-durable'
import type {
  ConversationId,
  EntryId,
  EntryRecord,
  LiveState,
  ToolSlot,
} from '@earendil-works/pi-durable'
import type { AssistantMessage, ToolCall } from '@earendil-works/pi-ai'
import {
  ArrowDown,
  Check,
  ChevronRight,
  CircleAlert,
  CircleStop,
  Pause,
  RotateCw,
} from '@lucide/solid'
import type { JSX } from '@solidjs/web'
import { cn } from 'cn'
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  onSettled,
  Show,
  Switch,
} from 'solid-js'

import { Message } from '@/components/ai/message.solid.tsx'
import { Reasoning } from '@/components/ai/reasoning.solid.tsx'
import { Shimmer } from '@/components/ai/shimmer.solid.tsx'
import { ToolStatusIcon } from '@/components/ai/tool.solid.tsx'
import { Markdown } from '@/components/markdown/markdown.solid.tsx'
import { Button } from '@/components/ui/button.solid.tsx'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible.solid.tsx'
import {
  covered,
  createTranscriptFrame,
  elidePath,
  EmptyTranscript,
  entryRenderers,
  messageItems,
  ParkedRuns,
  RunStart,
  toolLine,
  formatDuration,
  shortenPath,
  Transcript as TranscriptScope,
  useCompact,
  useConversation,
  useEvent,
  useExtensions,
  useModels,
  useNow,
  useStore,
  useSystem,
} from '../sdk/hooks.ts'
import {
  Contributed,
  Contribution,
  RenderedPoint,
  Slot,
  useProvided,
} from '../sdk/contribution.solid.tsx'
import {
  anchorSelector,
  compactRows,
  groupAside,
  groupBetween,
  isOpenIn,
  openIn,
  partKey,
  partsOf,
  runOf,
  setAsideIds,
} from './compact.ts'
import type { AsideGroup, BetweenGroup, CompactPart, WorkRun } from './compact.ts'
import { ContributionError } from './contribution-error.solid.tsx'
import { reportedFailure } from './error-stack.solid.tsx'
import { foldKey, readFold, writeFold } from './fold-state.ts'
import { follow } from './follow.ts'
import type { Follow } from './follow.ts'
import { createHistory } from './history.solid.tsx'
import { column } from './layout.ts'
import { MessageActions } from './message-actions.solid.tsx'
import { callsStart, indexTools, partialOf, slotsOf, toolCallView } from './model.ts'
import type { ToolResult } from './model.ts'
import { ToolCallBlock } from './tool-call.solid.tsx'
import { TranscriptSkeleton } from './transcript-skeleton.solid.tsx'
import { textOf } from './user-text.ts'
import { UserView } from './user-turn.solid.tsx'

type Row = CompactPart | WorkRun
type Item = Row | AsideGroup
type Shown = Item | BetweenGroup<Item>

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches

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

const rowGap = (content: Element | undefined) =>
  content ? Number.parseFloat(getComputedStyle(content).rowGap) || 0 : 0
const preloadOneViewportBeforeTop = '100% 0px 0px 0px'

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

  let scroll!: HTMLDivElement
  let content!: HTMLDivElement
  let pinned!: HTMLDivElement
  let sentinel: HTMLDivElement | undefined
  const [scroller, setScroller] = createSignal<Follow>()
  const [following, setFollowing] = createSignal(true)
  let tail!: HTMLDivElement
  let held: Element | null = null
  let maxPinnedCover = 0
  let releaseTailOnResize: (() => void) | undefined
  const [tailSpace, setTailSpaceSignal] = createSignal(0)
  const setTailSpace = (next: number | ((space: number) => number)) => {
    const space = typeof next === 'function' ? next(tailSpace()) : next
    tail.style.height = space > 0 ? `${space + rowGap(content)}px` : ''
    setTailSpaceSignal(space)
  }
  const restored = useStore((state) => state.restored)

  onSettled(() => {
    transcript.mount({ scroll, content })
    const controller = follow(scroll, content, () => {
      setFollowing(controller.following())
      transcript.setAtBottom(controller.atBottom())
      scroll.style.overflowAnchor = controller.following() ? 'none' : ''
    })
    scroll.style.overflowAnchor = 'none'
    setScroller(controller)
    if (id !== undefined && !restored() && !covered() && hasRows() && !reducedMotion())
      fadeInRowsNearTheEnd(scroll, content)
    return () => controller.dispose()
  })
  const hasRows = () => history.entries().length > 0

  const toEnd = (instant = false) => {
    held = null
    setTailSpace(0)
    scroller()?.toBottom(instant)
  }
  useEvent('ultimate:sent', (value) => {
    if ((value as { conversationId?: ConversationId } | undefined)?.conversationId === id)
      toEnd(true)
  })

  createEffect(tailSpace, (space) => {
    if (space === 0) return undefined
    const releaseTail = () => {
      if (held) return
      const bottom = scroll.scrollHeight - scroll.clientHeight
      const removingTailCannotClampReader = scroll.scrollTop <= bottom - space - rowGap(content)
      if (removingTailCannotClampReader || scroll.scrollTop >= bottom - 1) setTailSpace(0)
    }
    releaseTailOnResize = releaseTail
    scroll.addEventListener('scroll', releaseTail)
    releaseTail()
    return () => {
      releaseTailOnResize = undefined
      scroll.removeEventListener('scroll', releaseTail)
    }
  })

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

  let anchor: {
    entryId: EntryId
    last?: number
    inner?: boolean
    toolCallId?: string
    top: number
  } | null = null
  createEffect(history.history, () => {
    if (!anchor) return
    const { toolCallId: callId, top } = anchor
    const entry = content.querySelector(anchorSelector(anchor))
    const tool =
      callId === undefined
        ? undefined
        : entry?.querySelector(`[data-tool-call-id="${CSS.escape(callId)}"]`)
    const element = tool && tool.getBoundingClientRect().height > 0 ? tool : entry
    if (element) scroller()?.place(scroll.scrollTop + element.getBoundingClientRect().top - top)
    anchor = null
  })
  const keepVisibleRowsAbove = (page: readonly EntryRecord[]) => {
    const entries = history.entries()
    const { calls: mergedCalls } = indexTools([...entries, ...page])
    const newestPrependedEntry = Math.max(0, ...page.map((entry) => entry.id))
    const survivors = new Set<number>(
      entries
        .filter(
          (entry) =>
            entry.id > newestPrependedEntry &&
            !(entry.kind === 'pi.tool-result' && mergedCalls.has(toolCallId(entry) ?? '')),
        )
        .map((entry) => entry.id),
    )
    const viewTop = scroll.getBoundingClientRect().top
    const candidates = [...content.querySelectorAll(':scope > [data-entry-id]')]
      .flatMap((row) => {
        const inside = [...row.querySelectorAll('[data-entry-id]')]
        return inside.length ? inside : [row]
      })
      .filter((row) => row.getBoundingClientRect().bottom > viewTop)
    const survivingVisibleRow = candidates.find((row) =>
      survivors.has(Number(row.getAttribute('data-entry-id'))),
    )
    if (survivingVisibleRow) {
      anchor = {
        entryId: parseEntryId(Number(survivingVisibleRow.getAttribute('data-entry-id'))),
        last: Number(survivingVisibleRow.getAttribute('data-run-last')) || undefined,
        inner: !survivingVisibleRow.parentElement?.isSameNode(content),
        top: survivingVisibleRow.getBoundingClientRect().top,
      }
    } else if (candidates[0]) {
      const orphan = entries.find(
        (entry) => entry.id === Number(candidates[0].getAttribute('data-entry-id')),
      )
      const callId = orphan && toolCallId(orphan)
      const assistantReplacingOrphanResult = page.find((entry) => {
        const message = entry.model?.[0]
        return (
          entry.kind === 'pi.assistant' &&
          message?.role === 'assistant' &&
          message.content.some((block) => block.type === 'toolCall' && block.id === callId)
        )
      })
      if (assistantReplacingOrphanResult)
        anchor = {
          entryId: assistantReplacingOrphanResult.id,
          toolCallId: callId,
          top: candidates[0].getBoundingClientRect().top,
        }
    }
    const follower = scroller()
    if (follower && (!follower.following() || follower.left())) follower.stop()
    setTailSpace((space) => Math.max(space, scroll.clientHeight - content.clientHeight))
  }
  const stopFollowing = () => scroller()?.stop()
  createEffect(
    () => ({
      ready:
        !props.loading && !history.pending() && !history.error() && history.cursor() !== undefined,
      rows: history.history(),
      sentinel: hasRows(),
    }),
    ({ ready }) => {
      if (!ready || !sentinel) return undefined
      const observer = new IntersectionObserver(
        ([seen]) => {
          if (seen?.isIntersecting) void history.loadEarlier(keepVisibleRowsAbove)
        },
        { root: scroll, rootMargin: preloadOneViewportBeforeTop },
      )
      observer.observe(sentinel)
      return () => observer.disconnect()
    },
  )

  const hold = () => {
    const element = held
    const follower = scroller()
    if (!element || !follower) return
    if (!element.isConnected || follower.following()) {
      held = null
      return
    }
    maxPinnedCover = Math.max(maxPinnedCover, pinned.offsetHeight)
    const move =
      element.getBoundingClientRect().top - scroll.getBoundingClientRect().top - maxPinnedCover
    const contentBottom =
      content.getBoundingClientRect().bottom - scroll.getBoundingClientRect().top
    const roomBelow = contentBottom - scroll.clientHeight
    if (move > roomBelow) setTailSpace(tailSpace() + move - roomBelow + rowGap(content))
    follower.place(scroll.scrollTop + move)
  }
  onSettled(() => {
    const resize = new ResizeObserver(() => {
      hold()
      releaseTailOnResize?.()
    })
    for (const element of [scroll, content, pinned]) resize.observe(element)
    const release = () => {
      held = null
    }
    const inputs = ['wheel', 'touchstart', 'pointerdown', 'keydown']
    for (const type of inputs) scroll.addEventListener(type, release, { passive: true })
    return () => {
      resize.disconnect()
      for (const type of inputs) scroll.removeEventListener(type, release)
    }
  })

  const [reveal, setReveal] = createSignal<{ entry: EntryId; call?: string }>()
  useEvent('ultimate:reveal-entry', (value) => {
    const target = value as
      | { conversationId?: ConversationId; entryId?: EntryId; toolCallId?: string }
      | undefined
    const entryId = target?.entryId
    if (target?.conversationId === id && entryId !== undefined && Number.isSafeInteger(entryId))
      setReveal({ entry: entryId, call: target?.toolCallId })
  })
  createEffect(
    () => ({
      target: reveal(),
      waiting: props.loading || history.pending() || !scroller(),
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
          void history.loadDown(revealed, stopFollowing)
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
          : content.querySelector(`${row} [data-tool-call-id="${CSS.escape(call)}"]`)
      const element =
        block && block.getBoundingClientRect().height > 0 ? block : content.querySelector(row)
      if (element) {
        scroller()?.stop()
        held = element
        maxPinnedCover = 0
        hold()
      }
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
        const shown = () => shownAside().has(key())
        return (
          <Collapsible
            class={cn('group/aside', item.faded)}
            data-set-aside={group().steps}
            onOpenChange={(value) =>
              setShownAside((keys) => {
                const next = new Set(keys)
                if (value) next.add(key())
                else next.delete(key())
                return next
              })
            }
            open={shown()}
          >
            <CollapsibleTrigger
              class="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground/70 hover:text-muted-foreground"
              data-ui="transcript-meta"
            >
              {group().steps} step{group().steps === 1 ? '' : 's'} set aside ·{' '}
              {shown() ? 'hide' : 'show'}
              <ChevronRight
                aria-hidden="true"
                class="size-3 transition-transform group-data-open/aside:rotate-90"
              />
            </CollapsibleTrigger>
            <CollapsibleContent
              class="mt-3 flex flex-col gap-3 border-l border-dashed border-border/70 pl-3 opacity-70"
              data-ui="transcript-steps"
            >
              <For each={group().aside} keyed={partKeyOf}>
                {(inner) => <RowView last={false} row={inner()} />}
              </For>
            </CollapsibleContent>
          </Collapsible>
        )
      }}
    </Show>
  )

  return (
    <TranscriptScope value={transcript.frame}>
      <div class="relative min-h-0 flex-1 overflow-y-hidden" role="log">
        <div
          class="h-full w-full overflow-y-auto md:[scrollbar-gutter:stable_both-edges]"
          ref={scroll}
        >
          <div
            class={cn(column(props.dock), 'flex flex-col gap-3 pt-6 pb-10')}
            data-ui="transcript"
            ref={content}
          >
            <div class="pointer-events-none sticky top-0 z-10 -mb-3 h-0 [overflow-anchor:none]">
              <div ref={pinned}>
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
                ref={(element) => {
                  sentinel = element
                }}
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
            <div aria-hidden="true" class="-mt-3 shrink-0" data-history-anchor-space ref={tail} />
          </div>
        </div>
        <Show when={!following()}>
          <Button
            aria-label="Scroll to bottom"
            class="absolute bottom-3 left-1/2 size-7 -translate-x-1/2 rounded-full bg-popover shadow-md"
            onClick={() => toEnd()}
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

function fadeInRowsNearTheEnd(scroll: HTMLElement, content: HTMLElement) {
  const view = scroll.getBoundingClientRect()
  const rowsWithinOneViewportAbove = [...content.children].filter((row) => {
    const box = row.getBoundingClientRect()
    return box.height > 0 && box.bottom > view.top - view.height && box.top < view.bottom
  })
  rowsWithinOneViewportAbove.toReversed().forEach((row, index) =>
    row.animate([{ opacity: 0 }, { opacity: 1 }], {
      delay: index * 14,
      duration: 260,
      easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
      fill: 'backwards',
    }),
  )
}

const recedeRow =
  '-mt-1.5 opacity-45 transition-opacity duration-200 hover:opacity-100 focus-within:opacity-100'

const itemParts = (item: Item) => ('aside' in item ? item.aside.flatMap(partsOf) : partsOf(item))
const partKeyOf = (row: Row) => partKey(partsOf(row)[0])
const itemKey = (item: Item) =>
  'aside' in item ? `aside:${asideFirstEntryKey(item)}` : partKeyOf(item)
const shownKey = (item: Shown) =>
  'between' in item ? `between:${partKey(itemParts(item.between[0])[0])}` : itemKey(item)

const betweenEndpointKeys = (id: ConversationId | undefined, group: BetweenGroup<Item>) => {
  const parts = group.between.flatMap(itemParts)
  return [parts[0], parts.at(-1)!].map((part) => foldKey(id, `between:${partKey(part)}`))
}
const readBetween = (id: ConversationId | undefined, group: BetweenGroup<Item>) =>
  betweenEndpointKeys(id, group).some(readFold)
const writeBetween = (id: ConversationId | undefined, group: BetweenGroup<Item>, open: boolean) => {
  for (const key of betweenEndpointKeys(id, group)) writeFold(key, open)
}

function BetweenLine(props: {
  group: BetweenGroup<Item>
  open: boolean
  onOpen: () => void
  working: boolean
  summary: { extension: string; version: number; component: unknown } | undefined
}) {
  const flat = () => props.group.between.flatMap((row) => ('aside' in row ? row.aside : [row]))
  const rows = createMemo(() =>
    flat().flatMap((row) => ('work' in row ? [] : [{ entry: row.entry, calls: shownCalls(row) }])),
  )
  const steps = () =>
    props.group.between.reduce((sum, row) => sum + ('work' in row ? row.steps : 0), 0)
  const entries = createMemo(() =>
    flat()
      .flatMap((row) => ('work' in row ? row.work : [row]))
      .map((part) => part.entry),
  )
  const fallback = () => <>{rows().length} updates</>
  return (
    <Button
      aria-expanded={props.open ? 'true' : 'false'}
      class="my-1 flex h-auto w-full min-w-0 justify-start gap-3 rounded-none p-0 font-mono text-[11px] font-normal text-muted-foreground/60 before:h-px before:w-6 before:shrink-0 before:bg-border/60 after:h-px after:flex-1 after:bg-border/60 hover:text-muted-foreground"
      data-between={rows().length}
      onClick={() => props.onOpen()}
      size={null}
      variant={null}
    >
      <span class="flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap">
        <Show when={props.summary} fallback={fallback()}>
          {(summary) => (
            <Contribution
              fallback={(extension, error) => (
                <ContributionError error={error} extension={extension} inline>
                  {fallback()}
                </ContributionError>
              )}
              item={summary()}
              props={{
                get entries() {
                  return entries()
                },
                get rows() {
                  return rows()
                },
                get steps() {
                  return steps()
                },
                get working() {
                  return props.working
                },
              }}
            />
          )}
        </Show>
        <ChevronRight
          aria-hidden="true"
          class={cn('size-3 shrink-0 transition-transform', props.open && 'rotate-90')}
        />
      </span>
    </Button>
  )
}

const asideFirstEntryKey = (group: AsideGroup) => partsOf(group.aside[0])[0].entry.id

function shownCalls({ entry, blocks }: CompactPart): ToolCall[] {
  const message = entry.model?.[0]
  if (message?.role !== 'assistant') return []
  return message.content.flatMap((block, index) =>
    block.type === 'toolCall' && (!blocks || blocks.includes(index)) ? [block] : [],
  )
}

function WorkRow(props: {
  run: WorkRun
  working: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  results: Map<string, ToolResult>
  slots: Map<string, ToolSlot>
  busy: boolean
}) {
  return (
    <Collapsible
      class="group/work"
      onOpenChange={(open) => props.onOpenChange(open)}
      open={props.open}
    >
      <CollapsibleTrigger
        class="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground/70 hover:text-muted-foreground"
        data-ui="transcript-meta"
      >
        {props.working ? 'working' : 'worked'} · {props.run.steps} step
        {props.run.steps === 1 ? '' : 's'}
        <ChevronRight
          aria-hidden="true"
          class="size-3 transition-transform group-data-open/work:rotate-90"
        />
      </CollapsibleTrigger>
      <Show when={!props.open}>
        <StepLines
          busy={props.busy}
          onOpen={() => props.onOpenChange(true)}
          results={props.results}
          run={props.run}
          slots={props.slots}
        />
      </Show>
      <CollapsibleContent
        class="mt-3 flex flex-col gap-3 border-l border-border/70 pl-3"
        data-ui="transcript-steps"
      >
        <For each={props.run.work} keyed={partKey}>
          {(part) => (
            <div class="empty-row" data-entry-id={part().entry.id}>
              <EntryView
                blocks={part().blocks}
                busy={props.busy}
                entry={part().entry}
                results={props.results}
                slots={props.slots}
              />
            </div>
          )}
        </For>
      </CollapsibleContent>
    </Collapsible>
  )
}

function runCalls(run: WorkRun): { block: ToolCall; startedAt: number }[] {
  return run.work.flatMap(({ entry, blocks }) => {
    const message = entry.model?.[0]
    if (message?.role !== 'assistant') return []
    const startedAt = callsStart(message)
    return message.content.flatMap((block, index) =>
      block.type === 'toolCall' && (!blocks || blocks.includes(index))
        ? [{ block, startedAt }]
        : [],
    )
  })
}

const NEWEST_STEP_LINE_LIMIT = 8

function StepLines(props: {
  run: WorkRun
  results: Map<string, ToolResult>
  slots: Map<string, ToolSlot>
  busy: boolean
  onOpen: () => void
}) {
  const extensions = useExtensions()
  const calls = createMemo(() => runCalls(props.run))
  const shown = createMemo(() =>
    calls()
      .slice(-NEWEST_STEP_LINE_LIMIT)
      .map(({ block, startedAt }) =>
        toolCallView(block, {
          result: props.results.get(block.id),
          slot: props.slots.get(block.id),
          streaming: false,
          busy: props.busy,
          startedAt,
        }),
      ),
  )
  return (
    <Show when={calls().length > 0}>
      <Button
        aria-label={`Open ${calls().length} calls run #${props.run.work[0].entry.id}`}
        class="mt-1.5 flex h-auto w-full min-w-0 flex-col items-stretch gap-0.5 rounded-none border-l border-border/70 py-0 pr-0 pl-3 text-left font-mono text-[11.5px] leading-[1.6] font-normal whitespace-normal text-muted-foreground hover:text-foreground/90"
        onClick={() => props.onOpen()}
        size={null}
        variant={null}
      >
        <Show when={calls().length > shown().length}>
          <span class="text-muted-foreground/60">+{calls().length - shown().length} earlier</span>
        </Show>
        <For each={shown()} keyed={(call) => call.id}>
          {(call) => {
            const line = createMemo(() => toolLine(extensions(), call().name))
            return (
              <span class="flex min-w-0 items-center gap-2">
                <ToolStatusIcon class="size-3" state={call().status} />
                <span class="min-w-0 flex-1 truncate">
                  <Show when={line()} fallback={call().name}>
                    {(item) => (
                      <Contribution
                        fallback={(extension, error) => (
                          <ContributionError error={error} extension={extension} inline>
                            {call().name}
                          </ContributionError>
                        )}
                        item={item()}
                        props={{
                          get call() {
                            return call()
                          },
                        }}
                      />
                    )}
                  </Show>
                </span>
              </span>
            )
          }}
        </For>
      </Button>
    </Show>
  )
}

function EmptyState() {
  const system = useSystem()
  const conversation = useConversation()
  const agent = () => conversation().agent
  const models = useModels()
  const reasoning = () =>
    models()?.models.find(
      (model) => model.provider === agent().model?.provider && model.id === agent().model?.modelId,
    )?.reasoning
  const cwd = () => agent().cwd ?? system()?.execution.defaultCwd ?? ''
  const rows = (): { label: string; value: JSX.Element }[] => [
    {
      label: 'repo',
      value: (
        <>
          {elidePath(shortenPath(cwd(), { home: system()?.machine.home }), 44)}
          <Show when={system()?.code.branch && cwd() === system()?.code.ultimateRoot}>
            <span class="text-muted-foreground"> ({system()?.code.branch})</span>
          </Show>
        </>
      ),
    },
    {
      label: 'model',
      value: (
        <Show when={agent().model} fallback={<span class="text-warning">none configured</span>}>
          {(model) =>
            `${model().provider}/${model().modelId}${reasoning() !== false && agent().thinkingLevel ? ` · ${agent().thinkingLevel}` : ''}`
          }
        </Show>
      ),
    },
    {
      label: 'ext',
      value:
        system()
          ?.extensions.filter((extension) => extension.enabled)
          .map((extension) => extension.name)
          .join(' · ') ?? '…',
    },
    {
      label: 'host',
      value: system()
        ? `${system()!.machine.hostname} · ${system()!.process.node} · gen ${system()!.process.generation}`
        : '…',
    },
  ]
  return (
    <div class="flex size-full min-h-[55vh] flex-col items-center justify-center gap-3 p-8 text-center">
      <div class="w-full max-w-md font-mono text-[12px]" data-ui="empty-state">
        <div class="text-[13px] font-semibold tracking-[0.3em] text-brand" data-ui="wordmark">
          ULTIMATE
        </div>
        <div class="mt-1 font-sans text-[13px] text-muted-foreground">
          {!system() || system()!.project.root === system()!.code.ultimateRoot
            ? 'A coding agent that edits this repository, itself included.'
            : `A coding agent that edits ${system()!.project.name}, and can change itself too.`}
        </div>
        <div class="mt-5 grid grid-cols-[4rem_1fr] gap-x-3 gap-y-1 border-t border-border/70 pt-4 text-left">
          <For each={rows()}>
            {(row) => (
              <>
                <span class="text-muted-foreground/70">{row.label}</span>
                <span class="truncate text-foreground/85">{row.value}</span>
              </>
            )}
          </For>
        </div>
      </div>
    </div>
  )
}

function toolCallId(entry: EntryRecord) {
  const message = entry.model?.[0]
  return message?.role === 'toolResult' ? message.toolCallId : undefined
}

function EntryView(props: {
  entry: EntryRecord
  blocks?: readonly number[]
  results: Map<string, ToolResult>
  slots: Map<string, ToolSlot>
  busy: boolean
}) {
  const extensions = useExtensions()
  const renderers = createMemo(() => entryRenderers(extensions(), props.entry.kind))
  return (
    <Contributed
      core={() => (
        <CoreEntry
          blocks={props.blocks}
          busy={props.busy}
          entry={props.entry}
          results={props.results}
          slots={props.slots}
        />
      )}
      fallback={(extension, error, inner) => (
        <ContributionError error={error} extension={extension}>
          {inner()}
        </ContributionError>
      )}
      props={{
        get entry() {
          return props.entry
        },
        get blocks() {
          return props.blocks
        },
      }}
      renderers={renderers()}
    />
  )
}

function CoreEntry(props: {
  entry: EntryRecord
  blocks?: readonly number[]
  results: Map<string, ToolResult>
  slots: Map<string, ToolSlot>
  busy: boolean
}) {
  const message = () => props.entry.model?.[0]
  return (
    <Switch fallback={<UnknownEntry entry={props.entry} />}>
      <Match when={props.entry.kind === 'pi.user'}>
        <Show when={message()?.role === 'user' ? message() : undefined}>
          {(user) => (
            <UserView
              entry={props.entry}
              message={user() as Extract<ReturnType<typeof message>, { role: 'user' }>}
            />
          )}
        </Show>
      </Match>
      <Match when={props.entry.kind === 'pi.assistant'}>
        <Show when={message()?.role === 'assistant' ? (message() as AssistantMessage) : undefined}>
          {(assistant) => (
            <AssistantView
              blocks={props.blocks}
              busy={props.busy}
              entry={props.entry}
              message={assistant()}
              results={props.results}
              slots={props.slots}
            />
          )}
        </Show>
      </Match>
      <Match when={props.entry.kind === 'pi.system'}>
        <Show when={message()?.role === 'system'}>
          <Divider>system prompt changed</Divider>
        </Show>
      </Match>
      <Match when={props.entry.kind === 'pi.compaction'}>
        <CompactionView entry={props.entry} />
      </Match>
      <Match when={props.entry.kind === 'pi.reset'}>
        <Divider>context reset{message()?.role === 'user' ? ' · handoff' : ''}</Divider>
      </Match>
      <Match when={props.entry.kind === 'pi.tool-result'}>
        <Show when={message()?.role === 'toolResult' ? message() : undefined}>
          {(result) => {
            const value = () =>
              result() as Extract<ReturnType<typeof message>, { role: 'toolResult' }>
            const view = createCallView(() => ({
              call: {
                type: 'toolCall',
                id: value().toolCallId,
                name: value().toolName,
                arguments: {},
              },
              result: props.results.get(value().toolCallId),
              streaming: false,
              busy: props.busy,
            }))
            return <ToolCallBlock call={view()} />
          }}
        </Show>
      </Match>
    </Switch>
  )
}

function AssistantView(props: {
  entry?: EntryRecord
  message: AssistantMessage
  blocks?: readonly number[]
  results: Map<string, ToolResult>
  slots: Map<string, ToolSlot>
  busy: boolean
  streaming?: boolean
}) {
  const extensions = useExtensions()
  const labels = createMemo(() => messageItems(extensions(), 'answerLabels'))
  const streaming = () => props.streaming ?? false
  const last = () => props.message.content.length - 1
  const final = createMemo(
    () =>
      !streaming() &&
      props.message.stopReason === 'stop' &&
      !props.message.content.some((block) => block.type === 'toolCall') &&
      props.message.content.some((block) => block.type === 'text' && block.text.trim()),
  )
  const ended = () => !streaming() && props.message.stopReason !== 'toolUse'
  const ownsNoticeAndActions = () => !props.blocks || props.blocks.includes(last())
  const text = createMemo(() =>
    props.message.content
      .flatMap((block) => (block.type === 'text' && block.text.trim() ? [block.text] : []))
      .join('\n\n'),
  )
  const shown = (index: number) => !props.blocks || props.blocks.includes(index)
  return (
    <Message
      class={cn(
        'group/message gap-3',
        final() && 'rounded-lg border border-success/40 bg-success/5 px-3.5 py-2.5',
      )}
      data-final={final() || undefined}
      from="assistant"
    >
      <Show when={final()}>
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-success">
          <span class="inline-flex items-center gap-1.5">
            <Check aria-hidden="true" class="size-3.5" /> Final answer
          </span>
          <Show when={props.entry}>
            {(entry) => (
              <For each={labels()} keyed={(item) => item.key}>
                {(item) => (
                  <Contribution
                    fallback={(extension, error) => (
                      <ContributionError error={error} extension={extension} inline />
                    )}
                    item={item()}
                    props={{ entry: entry() }}
                  />
                )}
              </For>
            )}
          </Show>
        </div>
      </Show>
      <For each={props.message.content} keyed={false}>
        {(block, index) => (
          <Show when={shown(index)}>
            <Switch>
              <Match
                when={
                  block().type === 'thinking' &&
                  (block() as { thinking: string; redacted?: boolean })
                }
              >
                {(thinking) => (
                  <Show when={thinking().thinking || thinking().redacted}>
                    <Reasoning
                      label={`${streaming() && index === last() ? 'Thinking' : 'Thought'}${thinking().redacted ? ' (redacted)' : ''}`}
                      streaming={streaming() && index === last()}
                    >
                      {thinking().thinking}
                    </Reasoning>
                  </Show>
                )}
              </Match>
              <Match when={block().type === 'text' && (block() as { text: string }).text}>
                {(words) => <Markdown streaming={streaming() && index === last()} text={words()} />}
              </Match>
              <Match when={block().type === 'toolCall' && (block() as ToolCall)}>
                {(call) => {
                  const view = createCallView(() => ({
                    call: call(),
                    result: props.results.get(call().id),
                    slot: props.slots.get(call().id),
                    streaming: streaming(),
                    busy: props.busy,
                    startedAt: streaming() ? undefined : callsStart(props.message),
                  }))
                  return <ToolCallBlock call={view()} />
                }}
              </Match>
            </Switch>
          </Show>
        )}
      </For>
      <Show
        when={
          ownsNoticeAndActions() &&
          !streaming() &&
          (props.message.stopReason !== 'toolUse' || props.message.errorMessage)
        }
      >
        <AssistantNotice message={props.message} />
      </Show>
      <Show when={ownsNoticeAndActions() && (text() || ended()) ? props.entry : undefined}>
        {(entry) => (
          <MessageActions entry={entry()} text={text()} timestamp={props.message.timestamp} />
        )}
      </Show>
    </Message>
  )
}

function AssistantNotice(props: { message: AssistantMessage }) {
  return (
    <Switch>
      <Match when={props.message.stopReason === 'error'}>
        <div class="font-mono text-[11px]">
          <div class="flex items-start gap-1.5 text-error">
            <CircleAlert aria-hidden="true" class="mt-0.5 size-3.5 shrink-0" />
            <span class="min-w-0 break-words">
              {props.message.errorMessage ?? 'The provider returned an error'}
            </span>
          </div>
        </div>
      </Match>
      <Match when={props.message.stopReason === 'aborted'}>
        <div class="font-mono text-[11px]">
          <div class="flex items-center gap-1.5 text-muted-foreground">
            <CircleStop aria-hidden="true" class="size-3.5" /> aborted
          </div>
        </div>
      </Match>
      <Match when={props.message.stopReason === 'length'}>
        <div class="font-mono text-[11px]">
          <div class="flex items-center gap-1.5 text-warning">
            <CircleAlert aria-hidden="true" class="size-3.5" /> stopped at the output limit
          </div>
        </div>
      </Match>
    </Switch>
  )
}

function Divider(props: { children: JSX.Element }) {
  return (
    <div
      class="flex items-center gap-3 font-mono text-[11px] text-muted-foreground/70 before:h-px before:flex-1 before:bg-border/70 after:h-px after:flex-1 after:bg-border/70"
      data-ui="transcript-meta"
    >
      {props.children}
    </div>
  )
}

function CompactionView(props: { entry: EntryRecord }) {
  const summary = createMemo(() => {
    const message = props.entry.model?.[0]
    const wrapped = message?.role === 'user' ? textOf(message.content) : ''
    const start = wrapped.indexOf('<summary>\n')
    const end = wrapped.lastIndexOf('\n</summary>')
    return start >= 0 && end > start ? wrapped.slice(start + '<summary>\n'.length, end) : wrapped
  })
  const reason = () => (CompactionEntry.is(props.entry) ? props.entry.data?.reason : undefined)
  return (
    <Collapsible class="group/compaction rounded-lg border border-brand/30 bg-brand/5">
      <CollapsibleTrigger class="flex w-full flex-col gap-1 px-3.5 py-2.5 text-left">
        <span class="flex items-center gap-1.5 font-mono text-[11px] text-brand">
          <ChevronRight
            aria-hidden="true"
            class="size-3.5 transition-transform group-data-open/compaction:rotate-90"
          />
          Conversation condensed{reason() ? ` · ${reason()}` : ''}
        </span>
        <span class="text-xs text-muted-foreground">
          Prior conversation was condensed into a summary. Earlier messages remain available above.
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent class="border-t border-brand/20 px-3.5 py-2.5 text-[13px]">
        <Markdown text={summary()} />
      </CollapsibleContent>
    </Collapsible>
  )
}

function UnknownEntry(props: { entry: EntryRecord }) {
  return (
    <Collapsible class="group/unknown rounded-md border border-dashed border-border font-mono text-[11.5px]">
      <CollapsibleTrigger class="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-muted-foreground">
        <ChevronRight
          aria-hidden="true"
          class="size-3 transition-transform group-data-open/unknown:rotate-90"
        />
        {props.entry.kind}
        <span class="text-muted-foreground/60">#{props.entry.id}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre class="max-h-64 overflow-auto border-t border-dashed px-2.5 py-2 text-muted-foreground">
          {JSON.stringify({ data: props.entry.data, model: props.entry.model }, null, 2)}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  )
}

type CallInputs = {
  call: ToolCall
  result?: ToolResult
  slot?: ToolSlot
  streaming: boolean
  busy: boolean
  startedAt?: number
}

const sameCall = (a: CallInputs, b: CallInputs) =>
  a.call.id === b.call.id &&
  a.call.name === b.call.name &&
  a.call.arguments === b.call.arguments &&
  a.result?.message === b.result?.message &&
  a.slot === b.slot &&
  a.streaming === b.streaming &&
  a.startedAt === b.startedAt &&
  (a.result !== undefined || a.busy === b.busy)

function createCallView(inputs: () => CallInputs) {
  const current = createMemo(inputs, { equals: sameCall })
  return createMemo(() => {
    const { call, ...context } = current()
    return toolCallView(call, context)
  })
}

function partialHasVisibleContent(message: AssistantMessage | undefined) {
  return !!message?.content.some((block) =>
    block.type === 'toolCall'
      ? true
      : block.type === 'text'
        ? !!block.text
        : !!block.thinking || !!block.redacted,
  )
}

function LiveStatus(props: {
  id: ConversationId | undefined
  live: LiveState
  busy: boolean
  partial: AssistantMessage | undefined
}) {
  const parked = useProvided(ParkedRuns, () => null)
  const since = useProvided(RunStart, () => props.live.run?.taskId)
  return (
    <LiveLines
      busy={props.busy}
      live={props.live}
      parked={props.id !== undefined && parked()?.has(props.id) === true}
      partial={props.partial}
      since={since()}
    />
  )
}

export function LiveLines(props: {
  live: LiveState
  busy: boolean
  partial: AssistantMessage | undefined
  parked: boolean
  since?: number
}) {
  const paused = () => props.busy && props.parked
  const retry = () => (paused() ? undefined : props.live.generation?.retry)
  const running = () => (props.live.tools ?? []).some((slot) => slot.status !== 'done')
  const idle = () => props.busy && !partialHasVisibleContent(props.partial) && !running()
  const ticking = createMemo(() => !paused() && (!!retry() || idle()))
  const now = useNow(100, ticking)
  const compactions = () => props.live.compactions ?? []
  const working = () =>
    idle() && !retry() && !props.live.generation?.deferred && compactions().length === 0
  return (
    <Show
      when={!paused()}
      fallback={
        <div class="flex flex-col gap-1 font-mono text-[12px] text-muted-foreground">
          <span class="flex items-center gap-2 text-warning" data-paused-run>
            <Pause aria-hidden="true" class="size-3" />
            paused · runs on Play
          </span>
        </div>
      }
    >
      <Show
        when={retry() || props.live.generation?.deferred || compactions().length > 0 || working()}
      >
        <div class="flex flex-col gap-1 font-mono text-[12px] text-muted-foreground">
          <Show when={retry()}>
            {(pending) => (
              <span class="flex items-center gap-1.5 text-warning">
                <RotateCw aria-hidden="true" class="size-3" />
                retrying in {formatDuration(Math.max(0, pending().at - now()))} · attempt{' '}
                {props.live.generation?.attempt ?? 1} ·{' '}
                <span class="truncate">{pending().error}</span>
              </span>
            )}
          </Show>
          <Show when={props.live.generation?.deferred}>
            <Shimmer>waiting for the provider…</Shimmer>
          </Show>
          <For each={compactions()} keyed={(compaction) => compaction.taskId}>
            {(compaction) => (
              <Shimmer>
                {`compacting context · ${compaction().trigger}${compaction().attempt > 1 ? ` · attempt ${compaction().attempt}` : ''}…`}
              </Shimmer>
            )}
          </For>
          <Show when={working()}>
            <span class="flex items-center gap-2">
              <span class="size-1.5 animate-pulse-dot rounded-full bg-brand" />
              <Shimmer>
                {props.partial?.content.some((block) => block.type === 'thinking')
                  ? 'thinking…'
                  : 'working…'}
              </Shimmer>
              <Show when={props.since !== undefined && now() - props.since >= 2000}>
                <span class="text-muted-foreground/60 tabular-nums">
                  {formatDuration(now() - props.since!)}
                </span>
              </Show>
            </span>
          </Show>
        </div>
      </Show>
    </Show>
  )
}
