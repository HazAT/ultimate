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
import { cn } from 'cn'
import {
  CheckIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CircleStopIcon,
  PauseIcon,
  RotateCwIcon,
} from 'lucide-react'
import {
  Fragment,
  memo,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { ComponentType, ReactNode } from 'react'
import { useStickToBottomContext } from 'use-stick-to-bottom'
import type { StickToBottomContext } from 'use-stick-to-bottom'
import { useEvent } from '../sdk/events.ts'
import { Button } from '@/components/ui/button'
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from '@/components/ai/conversation'
import { Message, MessageResponse } from '@/components/ai/message'
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/components/ai/reasoning'
import { Shimmer } from '@/components/ai/shimmer'
import { ToolStatusIcon } from '@/components/ai/tool'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { elidePath, formatDuration, shortenPath } from '../sdk/format.ts'
import {
  TranscriptContext,
  useCompact,
  useCompactThread,
  useConversation,
  useExtensions,
  useModels,
  useNow,
  useStore,
  useSystem,
  useUltimate,
} from '../sdk/hooks.ts'
import { entryRenderers, messageItems, toolLine } from '../sdk/registry.ts'
import { covered } from '../sdk/resume.ts'
import { ExtensionBoundary, Provided, Rendered, Slot } from './boundary.tsx'
import { EmptyTranscript, ParkedRuns, RunStart } from '../sdk/types.ts'
import type { CompactSummaryProps } from '../sdk/types.ts'
import { MessageActions } from './message-actions.tsx'
import { textOf, UserView } from './user-turn.tsx'
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
import { foldKey, readFold, writeFold } from './fold.tsx'
import { useHistory } from './history.ts'
import { readerLeft } from './follow.ts'
import { column } from './layout.ts'
import { callsStart, indexTools, partialOf, slotsOf, toolCallView } from './model.ts'
import type { ToolResult } from './model.ts'
import { ToolCallBlock } from './tool-call.tsx'
import { TranscriptSkeleton } from './transcript-skeleton.tsx'

export function useTranscriptScroll() {
  const { scrollRef, contentRef, isAtBottom } = useStickToBottomContext()
  return { scrollRef, contentRef, atBottom: isAtBottom }
}

export function Transcript({ dock }: { dock?: boolean }) {
  const { id, loading } = useConversation()
  const { conversationId } = useUltimate()
  const hasPriorMessages = useStore((state) => {
    const shown = state.conversations.find(
      (conversation) => conversation.id === (conversationId ?? state.requested),
    )
    return shown?.inputAt !== undefined || shown?.answerAt !== undefined
  })
  const stick = useRef<StickToBottomContext>(null)
  const skeleton = useRef<HTMLDivElement>(null)
  const [placeholderThroughFadeOut, setPlaceholderThroughFadeOut] = useState(
    loading && hasPriorMessages,
  )
  if (loading && hasPriorMessages && !placeholderThroughFadeOut) setPlaceholderThroughFadeOut(true)
  useLayoutEffect(() => {
    if (loading || !placeholderThroughFadeOut) return undefined
    if (!skeleton.current || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setPlaceholderThroughFadeOut(false)
      return undefined
    }
    const fade = skeleton.current.animate([{ opacity: 0 }], {
      duration: 300,
      easing: 'ease-out',
      fill: 'forwards',
    })
    fade.finished.then(
      () => setPlaceholderThroughFadeOut(false),
      () => {},
    )
    return () => fade.cancel()
  }, [loading, placeholderThroughFadeOut])
  const restored = useStore((state) => state.restored)
  const revealRowsWithOpacityOnly = useEffectEvent((scroll: HTMLElement, content: HTMLElement) => {
    if (!hasPriorMessages || restored || covered()) return
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
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
  })
  useLayoutEffect(() => {
    const scroll = stick.current?.scrollRef.current
    const content = stick.current?.contentRef.current
    if (!scroll || !content) return undefined
    scroll.scrollTop = scroll.scrollHeight
    if (id !== undefined) revealRowsWithOpacityOnly(scroll, content)
    const resize = new ResizeObserver(() => {
      const state = stick.current?.state
      if (state?.isAtBottom) state.scrollTop = state.targetScrollTop
    })
    resize.observe(scroll)
    resize.observe(content)
    return () => resize.disconnect()
  }, [id])
  useEvent('ultimate:sent', (value) => {
    if ((value as { conversationId?: ConversationId } | undefined)?.conversationId === id)
      void stick.current?.scrollToBottom({ animation: 'instant' })
  })
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <Conversation className="min-h-0" contextRef={stick} key={id} resize="instant">
        <ConversationContent className={cn(column(dock), 'gap-3 pt-6 pb-10')} data-ui="transcript">
          <TranscriptEntries />
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      {placeholderThroughFadeOut && <TranscriptSkeleton dock={dock} ref={skeleton} />}
    </div>
  )
}

const rowGap = (content: Element | null) =>
  content ? Number.parseFloat(getComputedStyle(content).rowGap) || 0 : 0
const preloadOneViewportBeforeTop = '100% 0px 0px 0px'

function useAnchoringAfterAncestorRefs(
  scrollRef: StickToBottomContext['scrollRef'],
  following: boolean,
) {
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.style.overflowAnchor = following ? 'none' : ''
  }, [following, scrollRef])
}

function TranscriptEntries() {
  const { id, entries: active, older, live, busy, loading } = useConversation()
  const { entries, history, cursor, pending, error, filling, retry, loadEarlier, loadDown } =
    useHistory(id, active, older)
  const [tailSpace, setTailSpace] = useState(0)
  const anchor = useRef<{
    entryId: EntryId
    last?: number
    inner?: boolean
    toolCallId?: string
    top: number
  } | null>(null)
  const sentinel = useRef<HTMLDivElement>(null)
  const pinned = useRef<HTMLDivElement>(null)
  const { contentRef, scrollRef, stopScroll, state, isAtBottom, escapedFromLock } =
    useStickToBottomContext()
  const following = isAtBottom && !escapedFromLock
  useAnchoringAfterAncestorRefs(scrollRef, following)
  const topAtLastCapturedScroll = useRef(0)
  const left = useEffectEvent(() => {
    const scroll = scrollRef.current
    if (!scroll) return false
    return readerLeft({
      top: scroll.scrollTop,
      seen: topAtLastCapturedScroll.current,
      placed: state.ignoreScrollToTop,
      distance: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight,
    })
  })
  useEffect(() => {
    const scroll = scrollRef.current
    if (!scroll) return undefined
    topAtLastCapturedScroll.current = scroll.scrollTop
    const onScroll = () => {
      if (left()) stopScroll()
      topAtLastCapturedScroll.current = scroll.scrollTop
    }
    const captureBeforeLibraryClearsPlacement = true
    scroll.addEventListener('scroll', onScroll, {
      capture: captureBeforeLibraryClearsPlacement,
      passive: true,
    })
    return () =>
      scroll.removeEventListener('scroll', onScroll, {
        capture: captureBeforeLibraryClearsPlacement,
      })
  }, [scrollRef, stopScroll])
  useLayoutEffect(() => {
    if (anchor.current && scrollRef.current) {
      const { toolCallId: callId, top } = anchor.current
      const entry = contentRef.current?.querySelector(anchorSelector(anchor.current))
      const tool =
        callId === undefined
          ? undefined
          : entry?.querySelector(`[data-tool-call-id="${CSS.escape(callId)}"]`)
      const element = tool && tool.getBoundingClientRect().height > 0 ? tool : entry
      if (element) scrollRef.current.scrollTop += element.getBoundingClientRect().top - top
      anchor.current = null
    }
  }, [history, scrollRef, contentRef])
  useEffect(() => {
    const scroll = scrollRef.current
    if (!scroll || tailSpace === 0) return undefined
    const releaseTail = () => {
      const gap = rowGap(contentRef.current)
      const bottom = scroll.scrollHeight - scroll.clientHeight
      const removingTailCannotClampReader = scroll.scrollTop <= bottom - tailSpace - gap
      const readerReturnedToBottom = () => scroll.scrollTop >= bottom - 1
      if (removingTailCannotClampReader || readerReturnedToBottom()) setTailSpace(0)
    }
    scroll.addEventListener('scroll', releaseTail)
    releaseTail()
    return () => scroll.removeEventListener('scroll', releaseTail)
  }, [tailSpace, active, scrollRef, contentRef])
  const prependHistoryKeepingVisibleRows = useEffectEvent(() =>
    loadEarlier((page) => {
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
      const shown = (contentRef.current?.querySelectorAll(':scope > [data-entry-id]') ??
        []) as Iterable<Element>
      const candidates = [...shown]
        .flatMap((row) => {
          const inside = [...row.querySelectorAll('[data-entry-id]')]
          return inside.length ? inside : [row]
        })
        .filter(
          (row) =>
            row.getBoundingClientRect().bottom >
            (scrollRef.current?.getBoundingClientRect().top ?? 0),
        )
      const survivingVisibleRow = candidates.find((row) =>
        survivors.has(Number(row.getAttribute('data-entry-id'))),
      )
      if (survivingVisibleRow) {
        anchor.current = {
          entryId: parseEntryId(Number(survivingVisibleRow.getAttribute('data-entry-id'))),
          last: Number(survivingVisibleRow.getAttribute('data-run-last')) || undefined,
          inner: !survivingVisibleRow.parentElement?.isSameNode(contentRef.current),
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
          anchor.current = {
            entryId: assistantReplacingOrphanResult.id,
            toolCallId: callId,
            top: candidates[0].getBoundingClientRect().top,
          }
      }
      const readerLeftBeforeScrollEvent = !state.isAtBottom || left()
      if (readerLeftBeforeScrollEvent) stopScroll()
      setTailSpace((space) => {
        const emptyTailToKeepScrollable =
          (scrollRef.current?.clientHeight ?? 0) - (contentRef.current?.clientHeight ?? 0)
        return Math.max(space, emptyTailToKeepScrollable)
      })
    }),
  )
  useEffect(() => {
    const root = scrollRef.current
    if (!root || !sentinel.current || loading || pending || error || cursor === undefined)
      return undefined
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) void prependHistoryKeepingVisibleRows()
      },
      { root, rootMargin: preloadOneViewportBeforeTop },
    )
    observer.observe(sentinel.current)
    return () => observer.disconnect()
  }, [scrollRef, loading, pending, error, cursor, history])
  const { results, calls } = useMemo(() => indexTools(entries), [entries])
  const slotsUnaffectedByStreamedTokens = useMemo(() => slotsOf(live.tools), [live.tools])
  const partial = partialOf(live)
  const visible = entries.filter(
    (entry) =>
      entry.conversationId === id &&
      !(entry.kind === 'pi.tool-result' && calls.has(toolCallId(entry) ?? '')),
  )
  const thread = useCompactThread()
  const compact = useCompact()
  const keeps = (call: ToolCall) => !!compact?.(call)
  const rows: (CompactPart | WorkRun)[] = compact
    ? compactRows(visible, keeps)
    : visible.map((entry) => ({ entry }))
  const aside = useMemo(() => setAsideIds(entries), [entries])
  const grouped = groupAside(rows, aside)
  const follows = thread?.test
  const threaded = follows
    ? groupBetween(
        grouped,
        (row) =>
          !('work' in row || 'aside' in row) &&
          follows({ entry: row.entry, calls: shownCalls(row) }),
      )
    : grouped.map((row) => row)
  const [shownBetween, setShownBetween] = useState(0)
  const [shownAside, setShownAside] = useState<ReadonlySet<number>>(new Set())
  const [openedPartKeys, setOpenedPartKeys] = useState<ReadonlySet<string>>(new Set())
  const isOpen = (run: WorkRun) => isOpenIn(openedPartKeys, run)
  const open = (run: WorkRun, value: boolean) =>
    setOpenedPartKeys((keys) => openIn(keys, run, value))
  const revealedRowHeldBelowPinnedStrip = useRef<Element>(null)
  const maxPinnedCoverDuringHold = useRef(0)
  const adjustScrollWithoutReaderInput = (delta: number) => {
    state.scrollTop += delta
  }
  const hold = useEffectEvent(() => {
    const element = revealedRowHeldBelowPinnedStrip.current
    const scroll = scrollRef.current
    if (!element || !scroll) return
    if (!element.isConnected || state.isAtBottom) {
      revealedRowHeldBelowPinnedStrip.current = null
      return
    }
    maxPinnedCoverDuringHold.current = Math.max(
      maxPinnedCoverDuringHold.current,
      pinned.current?.offsetHeight ?? 0,
    )
    const move =
      element.getBoundingClientRect().top -
      scroll.getBoundingClientRect().top -
      maxPinnedCoverDuringHold.current
    const scrollRoomBelow = scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop
    if (move > scrollRoomBelow)
      setTailSpace(tailSpace + move - scrollRoomBelow + rowGap(contentRef.current))
    adjustScrollWithoutReaderInput(move)
  })
  useLayoutEffect(() => hold(), [tailSpace])
  useEffect(() => {
    const scroll = scrollRef.current
    const content = contentRef.current
    if (!scroll || !content || !pinned.current) return undefined
    const resize = new ResizeObserver(() => hold())
    for (const element of [scroll, content, pinned.current]) resize.observe(element)
    const release = () => {
      revealedRowHeldBelowPinnedStrip.current = null
    }
    const inputs = ['wheel', 'touchstart', 'pointerdown', 'keydown']
    for (const type of inputs) scroll.addEventListener(type, release, { passive: true })
    return () => {
      resize.disconnect()
      for (const type of inputs) scroll.removeEventListener(type, release)
    }
  }, [scrollRef, contentRef])
  const [reveal, setReveal] = useState<{ entry: EntryId; call?: string }>()
  useEvent('ultimate:reveal-entry', (value) => {
    const target = value as
      | { conversationId?: ConversationId; entryId?: EntryId; toolCallId?: string }
      | undefined
    const entryId = target?.entryId
    if (target?.conversationId === id && entryId !== undefined && Number.isSafeInteger(entryId))
      setReveal({ entry: entryId, call: target?.toolCallId })
  })
  const openGroupsThenRevealOnNextCommit = useEffectEvent(() => {
    if (reveal === undefined || loading || pending) return
    if (error) {
      setReveal(undefined)
      return
    }
    const { entry: revealed, call } = reveal
    if (!entries.some((entry) => entry.id === revealed)) {
      if (cursor !== undefined && revealed < cursor) {
        void loadDown(revealed, stopScroll)
        return
      }
      const gapFillWillBringRevealedEntry = filling
      if (gapFillWillBringRevealedEntry) return
    }
    const between = threaded.find(
      (row): row is BetweenGroup<(typeof grouped)[number]> =>
        'between' in row &&
        row.between.some((inner) => itemParts(inner).some((part) => part.entry.id === revealed)),
    )
    if (between && !readBetween(id, between)) {
      writeBetween(id, between, true)
      setShownBetween((count) => count + 1)
      return
    }
    const group = grouped.find(
      (row): row is AsideGroup => 'aside' in row && !!runOf(row.aside, revealed),
    )
    const first = group && asideFirstEntryKey(group)
    if (first !== undefined && !shownAside.has(first)) {
      setShownAside((keys) => new Set(keys).add(first))
      return
    }
    const run = compact && runOf(rows, revealed)
    if (run && !isOpen(run)) {
      open(run, true)
      return
    }
    const row = `[data-entry-id="${revealed}"]`
    const block =
      call === undefined
        ? undefined
        : contentRef.current?.querySelector(`${row} [data-tool-call-id="${CSS.escape(call)}"]`)
    const element =
      block && block.getBoundingClientRect().height > 0
        ? block
        : contentRef.current?.querySelector(row)
    if (element) {
      stopScroll()
      revealedRowHeldBelowPinnedStrip.current = element
      maxPinnedCoverDuringHold.current = 0
      hold()
    }
    setReveal(undefined)
  })
  useLayoutEffect(
    () => openGroupsThenRevealOnNextCommit(),
    [reveal, loading, pending, error, history, openedPartKeys, filling, shownAside, shownBetween],
  )
  const render = (row: CompactPart | WorkRun, last: boolean, faded = ''): ReactNode =>
    'work' in row ? (
      <div
        className={cn('empty:hidden', faded)}
        data-conversation-id={id}
        data-entry-id={row.work[0].entry.id}
        data-run-last={row.work.at(-1)!.entry.id}
        key={partKey(row.work[0])}
      >
        <WorkRow
          busy={busy}
          onOpenChange={(value) => open(row, value)}
          open={isOpen(row)}
          results={results}
          run={row}
          slots={slotsUnaffectedByStreamedTokens}
          working={busy && last}
        />
      </div>
    ) : (
      <div
        className={cn('empty:hidden', faded)}
        data-conversation-id={id}
        data-entry-id={row.entry.id}
        key={partKey(row)}
      >
        <EntryView
          blocks={row.blocks}
          busy={busy}
          entry={row.entry}
          results={results}
          slots={slotsUnaffectedByStreamedTokens}
        />
      </div>
    )
  return (
    <TranscriptContext value={entries}>
      <div className="pointer-events-none sticky top-0 z-10 -mb-3 h-0 [overflow-anchor:none]">
        <div ref={pinned}>
          <Slot name="transcript.top" />
        </div>
      </div>
      {!loading && entries.length > 0 && cursor !== undefined && (
        <div
          className="flex min-h-5 items-center justify-center font-mono text-[11px] text-muted-foreground/70"
          ref={sentinel}
        >
          {pending ? (
            <Shimmer>loading earlier messages…</Shimmer>
          ) : (
            error && (
              <span className="flex items-center gap-2" role="alert">
                <span className="text-error">Could not load earlier messages</span>
                <Button
                  className="h-6 cursor-pointer px-2 font-mono text-[11px]"
                  onClick={retry}
                  size="sm"
                  variant="ghost"
                >
                  Retry
                </Button>
              </span>
            )
          )}
        </div>
      )}
      {!loading &&
        visible.length === 0 &&
        !partial &&
        (id === undefined ? (
          <EmptyState />
        ) : (
          <Rendered input={{ conversation: id }} point={EmptyTranscript}>
            <EmptyState />
          </Rendered>
        ))}
      {!loading && visible.length > 0 && cursor === undefined && <Slot name="transcript.start" />}
      {threaded.map((item, index) => {
        const last = index === threaded.length - 1
        if (!('between' in item)) return renderItem(item, last)
        const key = `between:${partKey(itemParts(item.between[0])[0])}`
        const agentWorkingInLastStretch = busy && last
        const shown = agentWorkingInLastStretch || readBetween(id, item)
        const faded = item.between.map((inner, inside) =>
          renderItem(inner, last && inside === item.between.length - 1, recedeRow),
        )
        return (
          <Fragment key={key}>
            <BetweenLine
              group={item}
              onOpen={() => {
                writeBetween(id, item, !shown)
                setShownBetween((count) => count + 1)
              }}
              open={shown}
              summary={thread?.summary}
              working={busy && last}
            />
            {shown && faded}
            {shown && index < threaded.length - 1 && <BetweenRule />}
          </Fragment>
        )
      })}
      {partial && (
        <AssistantView
          busy
          message={partial}
          results={results}
          slots={slotsUnaffectedByStreamedTokens}
          streaming
        />
      )}
      <Slot name="transcript.end" />
      <LiveStatus busy={busy} id={id} live={live} partial={partial} />
      {tailSpace > 0 && (
        <div aria-hidden="true" data-history-anchor-space style={{ height: tailSpace }} />
      )}
    </TranscriptContext>
  )
  function renderItem(
    item: CompactPart | WorkRun | AsideGroup,
    last: boolean,
    faded = '',
  ): ReactNode {
    if (!('aside' in item)) return render(item, last, faded)
    const key = asideFirstEntryKey(item)
    const shown = shownAside.has(key)
    return (
      <Collapsible
        className={cn('group/aside', faded)}
        data-set-aside={item.steps}
        key={`aside:${key}`}
        onOpenChange={(value) =>
          setShownAside((keys) => {
            const next = new Set(keys)
            if (value) next.add(key)
            else next.delete(key)
            return next
          })
        }
        open={shown}
      >
        <CollapsibleTrigger
          className="flex cursor-pointer items-center gap-1.5 font-mono text-[11px] text-muted-foreground/70 hover:text-muted-foreground"
          data-ui="transcript-meta"
        >
          {item.steps} step{item.steps === 1 ? '' : 's'} set aside · {shown ? 'hide' : 'show'}
          <ChevronRightIcon className="size-3 transition-transform group-data-[state=open]/aside:rotate-90" />
        </CollapsibleTrigger>
        <CollapsibleContent
          className="mt-3 flex flex-col gap-3 border-l border-dashed border-border/70 pl-3 opacity-70"
          data-ui="transcript-steps"
        >
          {item.aside.map((inner) => render(inner, false))}
        </CollapsibleContent>
      </Collapsible>
    )
  }
}

const recedeRow =
  '-mt-1.5 opacity-45 transition-opacity duration-200 hover:opacity-100 focus-within:opacity-100'

const itemParts = (item: CompactPart | WorkRun | AsideGroup) =>
  'aside' in item ? item.aside.flatMap(partsOf) : partsOf(item)

const betweenEndpointKeys = (
  id: ConversationId | undefined,
  group: BetweenGroup<CompactPart | WorkRun | AsideGroup>,
) => {
  const parts = group.between.flatMap(itemParts)
  return [parts[0], parts.at(-1)!].map((part) => foldKey(id, `between:${partKey(part)}`))
}
const readBetween = (
  id: ConversationId | undefined,
  group: BetweenGroup<CompactPart | WorkRun | AsideGroup>,
) => betweenEndpointKeys(id, group).some(readFold)
const writeBetween = (
  id: ConversationId | undefined,
  group: BetweenGroup<CompactPart | WorkRun | AsideGroup>,
  open: boolean,
) => {
  for (const key of betweenEndpointKeys(id, group)) writeFold(key, open)
}

function BetweenRule() {
  return <div aria-hidden="true" className="my-1 h-px bg-border/50" />
}

function BetweenLine({
  group,
  open,
  onOpen,
  working,
  summary: Summary,
}: {
  group: BetweenGroup<CompactPart | WorkRun | AsideGroup>
  open: boolean
  onOpen: () => void
  working: boolean
  summary:
    | {
        extension: string
        version: number
        component: ComponentType<CompactSummaryProps>
      }
    | undefined
}) {
  const rows = group.between
    .flatMap((row) => ('aside' in row ? row.aside : [row]))
    .flatMap((row) => ('work' in row ? [] : [{ entry: row.entry, calls: shownCalls(row) }]))
  const steps = group.between.reduce((sum, row) => sum + ('work' in row ? row.steps : 0), 0)
  const entries = group.between
    .flatMap((row) => ('aside' in row ? row.aside : [row]))
    .flatMap((row) => ('work' in row ? row.work : [row]))
    .map((part) => part.entry)
  const fallback = <>{rows.length} updates</>
  return (
    <button
      aria-expanded={open}
      className="my-1 flex w-full min-w-0 cursor-pointer items-center gap-3 font-mono text-[11px] text-muted-foreground/60 transition-colors before:h-px before:w-6 before:shrink-0 before:bg-border/60 after:h-px after:flex-1 after:bg-border/60 hover:text-muted-foreground"
      data-between={rows.length}
      onClick={onOpen}
      type="button"
    >
      <span className="flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap">
        {Summary ? (
          <ExtensionBoundary
            extension={Summary.extension}
            fallback={fallback}
            variant="inline"
            version={Summary.version}
          >
            <Summary.component entries={entries} rows={rows} steps={steps} working={working} />
          </ExtensionBoundary>
        ) : (
          fallback
        )}
        <ChevronRightIcon
          className={cn('size-3 shrink-0 transition-transform', open && 'rotate-90')}
        />
      </span>
    </button>
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

function WorkRow({
  run,
  working,
  open,
  onOpenChange,
  results,
  slots,
  busy,
}: {
  run: WorkRun
  working: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  results: Map<string, ToolResult>
  slots: Map<string, ToolSlot>
  busy: boolean
}) {
  return (
    <Collapsible className="group/work" onOpenChange={onOpenChange} open={open}>
      <CollapsibleTrigger
        className="flex cursor-pointer items-center gap-1.5 font-mono text-[11px] text-muted-foreground/70 hover:text-muted-foreground"
        data-ui="transcript-meta"
      >
        {working ? 'working' : 'worked'} · {run.steps} step
        {run.steps === 1 ? '' : 's'}
        <ChevronRightIcon className="size-3 transition-transform group-data-[state=open]/work:rotate-90" />
      </CollapsibleTrigger>
      {!open && (
        <StepLines
          busy={busy}
          onOpen={() => onOpenChange(true)}
          results={results}
          run={run}
          slots={slots}
        />
      )}
      <CollapsibleContent
        className="mt-3 flex flex-col gap-3 border-l border-border/70 pl-3"
        data-ui="transcript-steps"
      >
        {run.work.map((part) => (
          <div className="empty:hidden" data-entry-id={part.entry.id} key={partKey(part)}>
            <EntryView
              blocks={part.blocks}
              busy={busy}
              entry={part.entry}
              results={results}
              slots={slots}
            />
          </div>
        ))}
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

function StepLines({
  run,
  results,
  slots,
  busy,
  onOpen,
}: {
  run: WorkRun
  results: Map<string, ToolResult>
  slots: Map<string, ToolSlot>
  busy: boolean
  onOpen: () => void
}) {
  const extensions = useExtensions()
  const calls = runCalls(run)
  if (calls.length === 0) return null
  const shown = calls.slice(-NEWEST_STEP_LINE_LIMIT)
  return (
    <button
      className="mt-1.5 flex w-full min-w-0 cursor-pointer flex-col gap-0.5 border-l border-border/70 pl-3 text-left font-mono text-[11.5px] leading-[1.6] text-muted-foreground hover:text-foreground/90"
      onClick={onOpen}
      type="button"
    >
      {calls.length > shown.length && (
        <span className="text-muted-foreground/60">+{calls.length - shown.length} earlier</span>
      )}
      {shown.map(({ block, startedAt }) => {
        const call = toolCallView(block, {
          result: results.get(block.id),
          slot: slots.get(block.id),
          streaming: false,
          busy,
          startedAt,
        })
        const line = toolLine(extensions, call.name)
        return (
          <span className="flex min-w-0 items-center gap-2" key={block.id}>
            <ToolStatusIcon className="size-3" state={call.status} />
            <span className="min-w-0 flex-1 truncate">
              {line ? (
                <ExtensionBoundary
                  extension={line.extension}
                  fallback={call.name}
                  variant="inline"
                  version={line.version}
                >
                  <line.component call={call} />
                </ExtensionBoundary>
              ) : (
                call.name
              )}
            </span>
          </span>
        )
      })}
    </button>
  )
}

function EmptyState() {
  const system = useSystem()
  const { agent } = useConversation()
  const reasoning = useModels()?.models.find(
    (model) => model.provider === agent.model?.provider && model.id === agent.model.modelId,
  )?.reasoning
  const cwd = agent.cwd ?? system?.execution.defaultCwd ?? ''
  const rows: { label: string; value: ReactNode }[] = [
    {
      label: 'repo',
      value: (
        <>
          {elidePath(shortenPath(cwd, { home: system?.machine.home }), 44)}
          {system?.code.branch && cwd === system.code.ultimateRoot && (
            <span className="text-muted-foreground"> ({system.code.branch})</span>
          )}
        </>
      ),
    },
    {
      label: 'model',
      value: agent.model ? (
        `${agent.model.provider}/${agent.model.modelId}${reasoning !== false && agent.thinkingLevel ? ` · ${agent.thinkingLevel}` : ''}`
      ) : (
        <span className="text-warning">none configured</span>
      ),
    },
    {
      label: 'ext',
      value:
        system?.extensions
          .filter((extension) => extension.enabled)
          .map((extension) => extension.name)
          .join(' · ') ?? '…',
    },
    {
      label: 'host',
      value: system
        ? `${system.machine.hostname} · ${system.process.node} · gen ${system.process.generation}`
        : '…',
    },
  ]
  return (
    <ConversationEmptyState className="min-h-[55vh]">
      <div className="w-full max-w-md font-mono text-[12px]" data-ui="empty-state">
        <div className="text-[13px] font-semibold tracking-[0.3em] text-brand" data-ui="wordmark">
          ULTIMATE
        </div>
        <div className="mt-1 font-sans text-[13px] text-muted-foreground">
          {!system || system.project.root === system.code.ultimateRoot
            ? 'A coding agent that edits this repository, itself included.'
            : `A coding agent that edits ${system.project.name}, and can change itself too.`}
        </div>
        <div className="mt-5 grid grid-cols-[4rem_1fr] gap-x-3 gap-y-1 border-t border-border/70 pt-4 text-left">
          {rows.map(({ label, value }) => (
            <Fragment key={label}>
              <span className="text-muted-foreground/70">{label}</span>
              <span className="truncate text-foreground/85">{value}</span>
            </Fragment>
          ))}
        </div>
      </div>
    </ConversationEmptyState>
  )
}

function toolCallId(entry: EntryRecord) {
  const message = entry.model?.[0]
  return message?.role === 'toolResult' ? message.toolCallId : undefined
}

interface RowProps {
  entry: EntryRecord
  blocks?: readonly number[]
  results: Map<string, ToolResult>
  slots: Map<string, ToolSlot>
  busy: boolean
}

const EntryView = memo(function EntryView({ entry, blocks, results, slots, busy }: RowProps) {
  return entryRenderers(useExtensions(), entry.kind).reduce<ReactNode>(
    (inner, { extension, version, component: Renderer }) => (
      <ExtensionBoundary extension={extension} fallback={inner} key={extension} version={version}>
        <Renderer blocks={blocks} core={inner} entry={entry} />
      </ExtensionBoundary>
    ),
    coreEntry(entry, results, slots, busy, blocks),
  )
}, sameEntryAndOwnCalls)

function rowCalls(entry: EntryRecord): string[] {
  const message = entry.model?.[0]
  if (message?.role === 'toolResult') return [message.toolCallId]
  if (message?.role !== 'assistant') return []
  return message.content.flatMap((block) => (block.type === 'toolCall' ? [block.id] : []))
}

function sameEntryAndOwnCalls(a: RowProps, b: RowProps) {
  if (a.entry !== b.entry || a.blocks?.join() !== b.blocks?.join()) return false
  return rowCalls(b.entry).every((id) => {
    const result = b.results.get(id)?.message
    return (
      a.results.get(id)?.message === result &&
      a.slots.get(id) === b.slots.get(id) &&
      (result !== undefined || a.busy === b.busy)
    )
  })
}

function coreEntry(
  entry: EntryRecord,
  results: Map<string, ToolResult>,
  slots: Map<string, ToolSlot>,
  busy: boolean,
  blocks?: readonly number[],
): ReactNode {
  const message = entry.model?.[0]
  switch (entry.kind) {
    case 'pi.user':
      return message?.role === 'user' ? <UserView entry={entry} message={message} /> : null
    case 'pi.assistant':
      return message?.role === 'assistant' ? (
        <AssistantView
          blocks={blocks}
          busy={busy}
          entry={entry}
          message={message}
          results={results}
          slots={slots}
        />
      ) : null
    case 'pi.system':
      return message?.role === 'system' ? <Divider>system prompt changed</Divider> : null
    case 'pi.compaction':
      return <CompactionView entry={entry} />
    case 'pi.reset':
      return <Divider>context reset{message?.role === 'user' ? ' · handoff' : ''}</Divider>
    case 'pi.tool-result': {
      if (message?.role !== 'toolResult') return null
      const call: ToolCall = {
        type: 'toolCall',
        id: message.toolCallId,
        name: message.toolName,
        arguments: {},
      }
      return (
        <ToolCallBlock
          call={toolCallView(call, {
            result: results.get(call.id),
            streaming: false,
            busy,
          })}
        />
      )
    }
    default:
      return <UnknownEntry entry={entry} />
  }
}

function AssistantView({
  entry,
  message,
  blocks,
  results,
  slots,
  busy,
  streaming = false,
}: {
  entry?: EntryRecord
  message: AssistantMessage
  blocks?: readonly number[]
  results: Map<string, ToolResult>
  slots: Map<string, ToolSlot>
  busy: boolean
  streaming?: boolean
}) {
  const extensions = useExtensions()
  const labels = messageItems(extensions, 'answerLabels')
  const last = message.content.length - 1
  const final =
    !streaming &&
    message.stopReason === 'stop' &&
    !message.content.some((block) => block.type === 'toolCall') &&
    message.content.some((block) => block.type === 'text' && block.text.trim())
  const ended = !streaming && message.stopReason !== 'toolUse'
  const lastBlockOwnsNoticeAndActions = !blocks || blocks.includes(last)
  const text = message.content
    .flatMap((block) => (block.type === 'text' && block.text.trim() ? [block.text] : []))
    .join('\n\n')
  return (
    <Message
      className={cn(
        'group/message gap-3',
        final && 'rounded-lg border border-success/40 bg-success/5 px-3.5 py-2.5',
      )}
      data-final={final || undefined}
      from="assistant"
    >
      {final && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-success">
          <span className="inline-flex items-center gap-1.5">
            <CheckIcon aria-hidden="true" className="size-3.5" /> Final answer
          </span>
          {entry &&
            labels.map(({ key, extension, version, component: Label }) => (
              <ExtensionBoundary extension={extension} fallback={null} key={key} version={version}>
                <Label entry={entry} />
              </ExtensionBoundary>
            ))}
        </div>
      )}
      {message.content.map((block, index) => {
        if (blocks && !blocks.includes(index)) return null
        switch (block.type) {
          case 'thinking':
            if (!block.thinking && !block.redacted) return null
            return (
              <Reasoning isStreaming={streaming && index === last} key={index}>
                <ReasoningTrigger
                  label={`${streaming && index === last ? 'Thinking' : 'Thought'}${block.redacted ? ' (redacted)' : ''}`}
                />
                <ReasoningContent>{block.thinking}</ReasoningContent>
              </Reasoning>
            )
          case 'text':
            return block.text ? (
              <MessageResponse isAnimating={streaming && index === last} key={index}>
                {block.text}
              </MessageResponse>
            ) : null
          case 'toolCall':
            return (
              <ToolCallBlock
                call={toolCallView(block, {
                  result: results.get(block.id),
                  slot: slots.get(block.id),
                  streaming,
                  busy,
                  startedAt: streaming ? undefined : callsStart(message),
                })}
                key={block.id}
              />
            )
        }
        return null
      })}
      {lastBlockOwnsNoticeAndActions &&
        !streaming &&
        (message.stopReason !== 'toolUse' || message.errorMessage) && (
          <AssistantNotice message={message} />
        )}
      {lastBlockOwnsNoticeAndActions && entry && (text || ended) && (
        <MessageActions entry={entry} text={text} timestamp={message.timestamp} />
      )}
    </Message>
  )
}

function AssistantNotice({ message }: { message: AssistantMessage }) {
  const { stopReason } = message
  const notice =
    stopReason === 'error' ? (
      <div className="flex items-start gap-1.5 text-error">
        <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
        <span className="min-w-0 break-words">
          {message.errorMessage ?? 'The provider returned an error'}
        </span>
      </div>
    ) : stopReason === 'aborted' ? (
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <CircleStopIcon className="size-3.5" /> aborted
      </div>
    ) : stopReason === 'length' ? (
      <div className="flex items-center gap-1.5 text-warning">
        <CircleAlertIcon className="size-3.5" /> stopped at the output limit
      </div>
    ) : null
  return notice && <div className="font-mono text-[11px]">{notice}</div>
}

function Divider({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'flex items-center gap-3 font-mono text-[11px] text-muted-foreground/70 before:h-px before:flex-1 before:bg-border/70 after:h-px after:flex-1 after:bg-border/70',
        className,
      )}
      data-ui="transcript-meta"
    >
      {children}
    </div>
  )
}

function CompactionView({ entry }: { entry: EntryRecord }) {
  const message = entry.model?.[0]
  const wrapped = message?.role === 'user' ? textOf(message.content) : ''
  const start = wrapped.indexOf('<summary>\n')
  const end = wrapped.lastIndexOf('\n</summary>')
  const summary =
    start >= 0 && end > start ? wrapped.slice(start + '<summary>\n'.length, end) : wrapped
  const reason = CompactionEntry.is(entry) ? entry.data?.reason : undefined
  return (
    <Collapsible className="group/compaction rounded-lg border border-brand/30 bg-brand/5">
      <CollapsibleTrigger className="flex w-full cursor-pointer flex-col gap-1 px-3.5 py-2.5 text-left">
        <span className="flex items-center gap-1.5 font-mono text-[11px] text-brand">
          <ChevronRightIcon className="size-3.5 transition-transform group-data-[state=open]/compaction:rotate-90" />
          Conversation condensed{reason ? ` · ${reason}` : ''}
        </span>
        <span className="text-xs text-muted-foreground">
          Prior conversation was condensed into a summary. Earlier messages remain available above.
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t border-brand/20 px-3.5 py-2.5 text-[13px]">
        <MessageResponse>{summary}</MessageResponse>
      </CollapsibleContent>
    </Collapsible>
  )
}

function UnknownEntry({ entry }: { entry: EntryRecord }) {
  return (
    <Collapsible className="group/unknown rounded-md border border-dashed border-border font-mono text-[11.5px]">
      <CollapsibleTrigger className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-muted-foreground">
        <ChevronRightIcon className="size-3 transition-transform group-data-[state=open]/unknown:rotate-90" />
        {entry.kind}
        <span className="text-muted-foreground/60">#{entry.id}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="max-h-64 overflow-auto border-t border-dashed px-2.5 py-2 text-muted-foreground">
          {JSON.stringify({ data: entry.data, model: entry.model }, null, 2)}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  )
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
  return (
    <Provided input={null} point={ParkedRuns}>
      {(parked) => (
        <Provided input={props.live.run?.taskId} point={RunStart}>
          {(since) => (
            <LiveLines
              {...props}
              parked={props.id !== undefined && parked?.has(props.id) === true}
              since={since}
            />
          )}
        </Provided>
      )}
    </Provided>
  )
}

export function LiveLines({
  live,
  busy,
  partial,
  parked,
  since: durableRunStartedAt,
}: {
  live: LiveState
  busy: boolean
  partial: AssistantMessage | undefined
  parked: boolean
  since?: number
}) {
  const paused = busy && parked
  const retry = paused ? undefined : live.generation?.retry
  const running = (live.tools ?? []).some((slot) => slot.status !== 'done')
  const idle = busy && !partialHasVisibleContent(partial) && !running
  const statusClockRunsOnlyUnpaused = !paused && (!!retry || idle)
  const now = useNow(100, statusClockRunsOnlyUnpaused)
  if (paused)
    return (
      <div className="flex flex-col gap-1 font-mono text-[12px] text-muted-foreground">
        <span className="flex items-center gap-2 text-warning" data-paused-run>
          <PauseIcon className="size-3" />
          paused · runs on Play
        </span>
      </div>
    )
  const lines: ReactNode[] = []
  if (retry)
    lines.push(
      <span className="flex items-center gap-1.5 text-warning" key="retry">
        <RotateCwIcon className="size-3" />
        retrying in {formatDuration(Math.max(0, retry.at - now))} · attempt{' '}
        {live.generation?.attempt ?? 1} · <span className="truncate">{retry.error}</span>
      </span>,
    )
  if (live.generation?.deferred)
    lines.push(<Shimmer key="deferred">waiting for the provider…</Shimmer>)
  for (const compaction of live.compactions ?? [])
    lines.push(
      <Shimmer key={`compaction-${compaction.taskId}`}>
        {`compacting context · ${compaction.trigger}${compaction.attempt > 1 ? ` · attempt ${compaction.attempt}` : ''}…`}
      </Shimmer>,
    )
  if (idle && lines.length === 0) {
    const thinking = partial?.content.some((block) => block.type === 'thinking')
    lines.push(
      <span className="flex items-center gap-2" key="working">
        <span className="size-1.5 animate-pulse-dot rounded-full bg-brand" />
        <Shimmer>{thinking ? 'thinking…' : 'working…'}</Shimmer>
        {durableRunStartedAt !== undefined && now - durableRunStartedAt >= 2000 && (
          <span className="text-muted-foreground/60 tabular-nums">
            {formatDuration(now - durableRunStartedAt)}
          </span>
        )}
      </span>,
    )
  }
  if (lines.length === 0) return null
  return (
    <div className="flex flex-col gap-1 font-mono text-[12px] text-muted-foreground">{lines}</div>
  )
}
