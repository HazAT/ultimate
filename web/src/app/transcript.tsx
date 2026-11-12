import type { AssistantMessage, ToolCall } from '@earendil-works/pi-ai'
import type { EntryRecord, LiveState, ToolSlot } from '@earendil-works/pi-durable'
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

/**
 * The transcript around a contribution: its scroller, the element holding its rows (each top-level row carries
 * `data-entry-id`), and whether it follows its newest row. For `transcript.*` slots.
 */
export function useTranscriptScroll() {
  const { scrollRef, contentRef, isAtBottom } = useStickToBottomContext()
  return { scrollRef, contentRef, atBottom: isAtBottom }
}

/** The shown conversation; `dock` fits it into a narrow side region. */
export function Transcript({ dock }: { dock?: boolean }) {
  const { id, loading } = useConversation()
  const { conversationId } = useUltimate()
  // A conversation without messages opens as it is: no placeholder, nothing rising in.
  const messages = useStore((state) => {
    const shown = state.conversations.find(
      (conversation) => conversation.id === (conversationId ?? state.requested),
    )
    return shown?.inputAt !== undefined || shown?.answerAt !== undefined
  })
  const stick = useRef<StickToBottomContext>(null)
  const skeleton = useRef<HTMLDivElement>(null)
  // The placeholder outlives loading by its fade-out, which crosses over with the rows coming in.
  const [placeholder, setPlaceholder] = useState(loading && messages)
  if (loading && messages && !placeholder) setPlaceholder(true)
  useLayoutEffect(() => {
    if (loading || !placeholder) return undefined
    if (!skeleton.current || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setPlaceholder(false)
      return undefined
    }
    const fade = skeleton.current.animate([{ opacity: 0 }], {
      duration: 300,
      easing: 'ease-out',
      fill: 'forwards',
    })
    fade.finished.then(
      () => setPlaceholder(false),
      () => {
        // Cancelled: another conversation started loading, and the placeholder stays for it.
      },
    )
    return () => fade.cancel()
  }, [loading, placeholder])
  // Rows on screen come in from the bottom up when a conversation first loads: not when there are none, when a resumed
  // reload already shows them, or when this tab showed them before (`restored`), which opens as it was.
  // Opacity only: a moving row would suspend the browser's scroll anchoring while older rows render above.
  const restored = useStore((state) => state.restored)
  const reveal = useEffectEvent((scroll: HTMLElement, content: HTMLElement) => {
    if (!messages || restored || covered()) return
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
    // Rows settle shorter as they finish rendering, pulling rows from above into view: animate a screen of those too.
    const view = scroll.getBoundingClientRect()
    const rows = [...content.children].filter((row) => {
      const box = row.getBoundingClientRect()
      return box.height > 0 && box.bottom > view.top - view.height && box.top < view.bottom
    })
    rows.toReversed().forEach((row, index) =>
      row.animate([{ opacity: 0 }, { opacity: 1 }], {
        delay: index * 14,
        duration: 260,
        easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
        fill: 'backwards',
      }),
    )
  })
  // Paint a newly shown conversation at its newest row; sticking to the bottom only scrolls a frame later.
  useLayoutEffect(() => {
    const scroll = stick.current?.scrollRef.current
    const content = stick.current?.contentRef.current
    if (!scroll || !content) return undefined
    scroll.scrollTop = scroll.scrollHeight
    if (id !== undefined) reveal(scroll, content)
    // Pin to the bottom before paint as content grows or the viewport shrinks: the library follows a frame later, and in
    // that frame the scrollbar thumb jumps. Its follow lock still decides, so nobody reading older messages is pulled.
    const resize = new ResizeObserver(() => {
      const state = stick.current?.state
      if (state?.isAtBottom) state.scrollTop = state.targetScrollTop
    })
    resize.observe(scroll)
    resize.observe(content)
    return () => resize.disconnect()
  }, [id])
  // A sent message pins the view to the bottom and follows the run, even when the reader had scrolled up.
  useEvent('ultimate:sent', (value) => {
    if ((value as { conversationId?: number } | undefined)?.conversationId === id)
      // oxlint-disable-next-line typescript/no-floating-promises -- use-stick-to-bottom's frame loop resolves a boolean; it performs no rejecting async work.
      void stick.current?.scrollToBottom({ animation: 'instant' })
  })
  // Keyed so a conversation never inherits the previous one's scroll position or follow state.
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <Conversation className="min-h-0" contextRef={stick} key={id} resize="instant">
        <ConversationContent className={cn(column(dock), 'gap-3 pt-6 pb-10')} data-ui="transcript">
          <TranscriptEntries />
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      {placeholder && <TranscriptSkeleton dock={dock} ref={skeleton} />}
    </div>
  )
}

/** The space between a transcript's rows. */
const rowGap = (content: Element | null) =>
  content ? Number.parseFloat(getComputedStyle(content).rowGap) || 0 : 0

function TranscriptEntries() {
  const { id, entries: active, older, live, busy, loading } = useConversation()
  const { entries, history, cursor, pending, error, filling, retry, loadEarlier, loadDown } =
    useHistory(id, active, older)
  const [tailSpace, setTailSpace] = useState(0)
  const anchor = useRef<{
    entryId: number
    /** The last entry of a folded run: its row keeps that id when a page brings earlier entries into the run. */
    last?: number
    /** A row inside an opened run. */
    inner?: boolean
    toolCallId?: string
    top: number
  } | null>(null)
  const sentinel = useRef<HTMLDivElement>(null)
  /** What `transcript.top` pins over the top of the rows. */
  const pinned = useRef<HTMLDivElement>(null)
  const { contentRef, scrollRef, stopScroll, state, isAtBottom, escapedFromLock } =
    useStickToBottomContext()
  // While following, the browser must not anchor: a row above that shrinks as the last one grows would move the view up,
  // and the library reads that scroll as the reader leaving. A reader who scrolled up keeps anchoring, so rows changing
  // above them stay put. A passive effect: the scroller, an ancestor, attaches its ref after these rows' layout effects.
  const following = isAtBottom && !escapedFromLock
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.style.overflowAnchor = following ? 'none' : ''
  }, [following, scrollRef])
  // Stop following the moment the reader moves the view up: the library notices touch, keyboard and scrollbar scrolls a
  // moment late, or not at all while content resizes. Captured, so it reads the library's own last placement before
  // the library's listener clears it.
  const seenTop = useRef(0)
  const left = useEffectEvent(() => {
    const scroll = scrollRef.current
    if (!scroll) return false
    return readerLeft({
      top: scroll.scrollTop,
      seen: seenTop.current,
      placed: state.ignoreScrollToTop,
      distance: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight,
    })
  })
  useEffect(() => {
    const scroll = scrollRef.current
    if (!scroll) return undefined
    seenTop.current = scroll.scrollTop
    const onScroll = () => {
      if (left()) stopScroll()
      seenTop.current = scroll.scrollTop
    }
    scroll.addEventListener('scroll', onScroll, {
      capture: true,
      passive: true,
    })
    return () => scroll.removeEventListener('scroll', onScroll, { capture: true })
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
      // Release temporary space once it cannot clamp the reader, or they return to the bottom.
      const gap = rowGap(contentRef.current)
      const bottom = scroll.scrollHeight - scroll.clientHeight
      if (scroll.scrollTop <= bottom - tailSpace - gap || scroll.scrollTop >= bottom - 1)
        setTailSpace(0)
    }
    scroll.addEventListener('scroll', releaseTail)
    releaseTail()
    return () => scroll.removeEventListener('scroll', releaseTail)
  }, [tailSpace, active, scrollRef, contentRef])
  // Page in earlier history, holding the rows the reader sees in place while the page goes in above them.
  const earlier = useEffectEvent(() =>
    loadEarlier((page) => {
      const { calls: mergedCalls } = indexTools([...entries, ...page])
      // Rows older than the page, such as a head marker shown first, stay above it: anchor a row the page goes above.
      const newest = Math.max(0, ...page.map((entry) => entry.id))
      const survivors = new Set<number>(
        entries
          .filter(
            (entry) =>
              entry.id > newest &&
              !(entry.kind === 'pi.tool-result' && mergedCalls.has(toolCallId(entry) ?? '')),
          )
          .map((entry) => entry.id),
      )
      // Rows the reader sees: top-level rows, and the rows inside an opened run instead of the run itself, whose top stays
      // put while a page reaches into it and grows it above them; an inner anchor is found inside its run only.
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
      // A result row disappears when this page brings its assistant call. Anchor a surviving
      // row, or its matching replacement tool when no existing displayed row survives.
      const element = candidates.find((row) =>
        survivors.has(Number(row.getAttribute('data-entry-id'))),
      )
      if (element) {
        anchor.current = {
          entryId: Number(element.getAttribute('data-entry-id')),
          last: Number(element.getAttribute('data-run-last')) || undefined,
          inner: !element.parentElement?.isSameNode(contentRef.current),
          top: element.getBoundingClientRect().top,
        }
      } else if (candidates[0]) {
        const orphan = entries.find(
          (entry) => entry.id === Number(candidates[0].getAttribute('data-entry-id')),
        )
        const callId = orphan && toolCallId(orphan)
        const replacement = page.find((entry) => {
          const message = entry.model?.[0]
          return (
            entry.kind === 'pi.assistant' &&
            message?.role === 'assistant' &&
            message.content.some((block) => block.type === 'toolCall' && block.id === callId)
          )
        })
        if (replacement)
          anchor.current = {
            entryId: replacement.id,
            toolCallId: callId,
            top: candidates[0].getBoundingClientRect().top,
          }
      }
      // The anchor holds the rows in place; a reader who left the bottom stops following, even when the page arrives
      // before their scroll's event.
      if (!state.isAtBottom || left()) stopScroll()
      // A short transcript needs its existing empty tail to remain scrollable after prepending.
      setTailSpace((space) =>
        Math.max(
          space,
          (scrollRef.current?.clientHeight ?? 0) - (contentRef.current?.clientHeight ?? 0),
        ),
      )
    }),
  )
  // Page in earlier history while the top comes within a viewport. A new observer after each page reports at once
  // whether the top is still that close.
  useEffect(() => {
    const root = scrollRef.current
    if (!root || !sentinel.current || loading || pending || error || cursor === undefined)
      return undefined
    const observer = new IntersectionObserver(
      ([entry]) => {
        // oxlint-disable-next-line typescript/no-floating-promises -- loadEarlier catches history failures and displays them with setError.
        if (entry?.isIntersecting) void earlier()
      },
      { root, rootMargin: '100% 0px 0px 0px' },
    )
    observer.observe(sentinel.current)
    return () => observer.disconnect()
  }, [scrollRef, loading, pending, error, cursor, history])
  const { results, calls } = useMemo(() => indexTools(entries), [entries])
  // Keyed on the tools, not `live`: a streamed token must not re-render every row.
  const slots = useMemo(() => slotsOf(live.tools), [live.tools])
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
  // What a go-back set aside folds into one quiet row; the rows themselves render as usual inside it.
  const aside = useMemo(() => setAsideIds(entries), [entries])
  const grouped = groupAside(rows, aside)
  // What lies between two rows of what the reader follows folds into one line that opens it.
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
  // Folded runs the reader or a reveal opened, by the keys of all their parts: a run that gains earlier entries from a
  // page, or later ones live, stays open.
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set())
  const isOpen = (run: WorkRun) => isOpenIn(opened, run)
  const open = (run: WorkRun, value: boolean) => setOpened((keys) => openIn(keys, run, value))
  // A revealed row keeps its top at the top of the view, below what `transcript.top` pins over the rows, while what is
  // above it settles: the pinned strip arriving after the jump, rows above finishing their layout (Safari does not
  // anchor scrolling). The reader's own scroll or tap, or following the newest row again, lets it go.
  const held = useRef<Element>(null)
  // The most the strip covered while holding: it hides while the start card shows, and chasing that would loop.
  const cover = useRef(0)
  const hold = useEffectEvent(() => {
    const element = held.current
    const scroll = scrollRef.current
    if (!element || !scroll) return
    if (!element.isConnected || state.isAtBottom) {
      held.current = null
      return
    }
    cover.current = Math.max(cover.current, pinned.current?.offsetHeight ?? 0)
    const move =
      element.getBoundingClientRect().top - scroll.getBoundingClientRect().top - cover.current
    // A short row at the end needs room below it to reach the top: tail space, with a row gap more so the reader is not
    // at the very bottom, where it is released.
    const room = scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop
    if (move > room) setTailSpace(tailSpace + move - room + rowGap(contentRef.current))
    // Through the library's setter, so its scroll handler does not take the move for the reader's.
    // oxlint-disable-next-line react/immutability -- the library's state is its own mutable object; it writes it the same way.
    state.scrollTop += move
  })
  useEffect(() => {
    const scroll = scrollRef.current
    const content = contentRef.current
    if (!scroll || !content || !pinned.current) return undefined
    const resize = new ResizeObserver(() => hold())
    for (const element of [scroll, content, pinned.current]) resize.observe(element)
    const release = () => {
      held.current = null
    }
    const inputs = ['wheel', 'touchstart', 'pointerdown', 'keydown']
    for (const type of inputs) scroll.addEventListener(type, release, { passive: true })
    return () => {
      resize.disconnect()
      for (const type of inputs) scroll.removeEventListener(type, release)
    }
  }, [scrollRef, contentRef])
  // Reveal a stored row, or one tool call in it, without the auto-follow animation overriding the jump; a row older than
  // those loaded needs the history down to it first, and one in a folded run needs the run open.
  const [reveal, setReveal] = useState<{ entry: number; call?: string }>()
  useEvent('ultimate:reveal-entry', (value) => {
    const target = value as
      | { conversationId?: number; entryId?: number; toolCallId?: string }
      | undefined
    const entryId = target?.entryId
    if (target?.conversationId === id && entryId !== undefined && Number.isSafeInteger(entryId))
      setReveal({ entry: entryId, call: target?.toolCallId })
  })
  const revealStep = useEffectEvent(() => {
    if (reveal === undefined || loading || pending) return
    if (error) {
      setReveal(undefined)
      return
    }
    const { entry: revealed, call } = reveal
    if (!entries.some((entry) => entry.id === revealed)) {
      if (cursor !== undefined && revealed < cursor) {
        // oxlint-disable-next-line typescript/no-floating-promises -- loadDown catches history failures and displays them with setError.
        void loadDown(revealed, stopScroll)
        return
      }
      // Inside the window's range: a fill still reading it brings it.
      if (filling) return
    }
    // Open its stretch between thread rows, set-aside group and folded run first; the next commit scrolls.
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
    const first = group && asideKey(group)
    if (first !== undefined && !shownAside.has(first)) {
      setShownAside((keys) => new Set(keys).add(first))
      return
    }
    const run = compact && runOf(rows, revealed)
    if (run && !isOpen(run)) {
      open(run, true)
      return
    }
    // In compact mode an entry's text and its kept tools are separate rows, each with the entry's id.
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
      held.current = element
      cover.current = 0
      hold()
    }
    setReveal(undefined)
  })
  useLayoutEffect(
    () => revealStep(),
    [reveal, loading, pending, error, history, opened, filling, shownAside, shownBetween],
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
          slots={slots}
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
          slots={slots}
        />
      </div>
    )
  return (
    <TranscriptContext value={entries}>
      {/* At the top of the view as it scrolls, taking no room: its margin cancels the gap after it. */}
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
        // The stretch the agent works in now stays in view while it works.
        const shown = (busy && last) || readBetween(id, item)
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
        <AssistantView busy message={partial} results={results} slots={slots} streaming />
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
    const key = asideKey(item)
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

/** Opened rows between thread rows stay faded and tighter, back to full on hover or focus. */
const recedeRow =
  '-mt-1.5 opacity-45 transition-opacity duration-200 hover:opacity-100 focus-within:opacity-100'

/** All parts of a top-level row, set-aside groups included. */
const itemParts = (item: CompactPart | WorkRun | AsideGroup) =>
  'aside' in item ? item.aside.flatMap(partsOf) : partsOf(item)

/**
 * Whether the reader opened a stretch: kept in this browser per conversation, under its first and its last part, so it
 * stays open when a page brings earlier rows into it or live rows join it.
 */
const betweenKeys = (
  id: number | undefined,
  group: BetweenGroup<CompactPart | WorkRun | AsideGroup>,
) => {
  const parts = group.between.flatMap(itemParts)
  return [parts[0], parts.at(-1)!].map((part) => foldKey(id, `between:${partKey(part)}`))
}
const readBetween = (
  id: number | undefined,
  group: BetweenGroup<CompactPart | WorkRun | AsideGroup>,
) => betweenKeys(id, group).some(readFold)
const writeBetween = (
  id: number | undefined,
  group: BetweenGroup<CompactPart | WorkRun | AsideGroup>,
  open: boolean,
) => {
  for (const key of betweenKeys(id, group)) writeFold(key, open)
}

/** The hairline that closes a stretch between thread rows. */
function BetweenRule() {
  return <div aria-hidden="true" className="my-1 h-px bg-border/50" />
}

/**
 * A stretch between thread rows as a hairline divider carrying its summary, which opens or closes it.
 */
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
  // Rows outside runs of work, which count as steps instead.
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

/** A set-aside group is known by its first entry, so it stays open while later rows join it. */
const asideKey = (group: AsideGroup) => partsOf(group.aside[0])[0].entry.id

/** The tool calls a row shows: all of its entry's, or those of its blocks. */
function shownCalls({ entry, blocks }: CompactPart): ToolCall[] {
  const message = entry.model?.[0]
  if (message?.role !== 'assistant') return []
  return message.content.flatMap((block, index) =>
    block.type === 'toolCall' && (!blocks || blocks.includes(index)) ? [block] : [],
  )
}

/** A run of work in compact mode as one quiet row that expands to the usual rendering. */
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

/** The tool calls of a folded run, in order. */
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

/** Lines a folded run lists before “+N earlier”: the newest ones. */
const STEP_LINES = 8

/** A folded run's tool calls as a quiet list of one-line steps, newest last; clicking it opens the run. */
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
  const shown = calls.slice(-STEP_LINES)
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

/** What this Ultimate is and runs on, before the first message. */
function EmptyState() {
  const system = useSystem()
  const { agent } = useConversation()
  const reasoning = useModels()?.models.find(
    (model) => model.provider === agent.model?.provider && model.id === agent.model.modelId,
  )?.reasoning
  const cwd = agent.cwd ?? system?.execution.defaultCwd ?? ''
  const rows: [string, ReactNode][] = [
    [
      'repo',
      <>
        {elidePath(shortenPath(cwd, { home: system?.machine.home }), 44)}
        {system?.code.branch && cwd === system.code.ultimateRoot && (
          <span className="text-muted-foreground"> ({system.code.branch})</span>
        )}
      </>,
    ],
    [
      'model',
      agent.model ? (
        `${agent.model.provider}/${agent.model.modelId}${reasoning !== false && agent.thinkingLevel ? ` · ${agent.thinkingLevel}` : ''}`
      ) : (
        // oxlint-disable-next-line react/jsx-key -- a [label, value] row, not a rendered list
        <span className="text-warning">none configured</span>
      ),
    ],
    [
      'ext',
      system?.extensions
        .filter((extension) => extension.enabled)
        .map((extension) => extension.name)
        .join(' · ') ?? '…',
    ],
    [
      'host',
      system
        ? `${system.machine.hostname} · ${system.process.node} · gen ${system.process.generation}`
        : '…',
    ],
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
          {rows.map(([label, value]) => (
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
  /** The content blocks of an assistant message shown in this row; all when absent. */
  blocks?: readonly number[]
  results: Map<string, ToolResult>
  slots: Map<string, ToolSlot>
  busy: boolean
}

const EntryView = memo(function EntryView({ entry, blocks, results, slots, busy }: RowProps) {
  // Renderers compose in discovery order: each receives the one before it as `core`, and falls back to it.
  return entryRenderers(useExtensions(), entry.kind).reduce<ReactNode>(
    (inner, { extension, version, component: Renderer }) => (
      <ExtensionBoundary extension={extension} fallback={inner} key={extension} version={version}>
        <Renderer blocks={blocks} core={inner} entry={entry} />
      </ExtensionBoundary>
    ),
    coreEntry(entry, results, slots, busy, blocks),
  )
}, sameRow)

/** The tool calls a row shows: an assistant's calls, or the call of a result shown on its own. */
function rowCalls(entry: EntryRecord): string[] {
  const message = entry.model?.[0]
  if (message?.role === 'toolResult') return [message.toolCallId]
  if (message?.role !== 'assistant') return []
  return message.content.flatMap((block) => (block.type === 'toolCall' ? [block.id] : []))
}

/** A row changes only with its entry and its own calls, so a new entry or run re-renders just the rows it touches. */
function sameRow(a: RowProps, b: RowProps) {
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
  /** Show only these content blocks; the notice and actions go with the last block. */
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
  const tail = !blocks || blocks.includes(last)
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
              // oxlint-disable-next-line react/no-array-index-key -- Message content blocks are addressed by index.
              <Reasoning isStreaming={streaming && index === last} key={index}>
                <ReasoningTrigger
                  label={`${streaming && index === last ? 'Thinking' : 'Thought'}${block.redacted ? ' (redacted)' : ''}`}
                />
                <ReasoningContent>{block.thinking}</ReasoningContent>
              </Reasoning>
            )
          case 'text':
            return block.text ? (
              // oxlint-disable-next-line react/no-array-index-key -- Message content blocks are addressed by index.
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
      {tail && !streaming && (message.stopReason !== 'toolUse' || message.errorMessage) && (
        <AssistantNotice message={message} />
      )}
      {tail && entry && (text || ended) && (
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
        <span className="break-words">
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
  const reason = (entry.data as { reason?: string } | undefined)?.reason
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

/** Whether a streaming partial shows anything yet; a reasoning model's first phase is often an empty thinking block. */
function shows(message: AssistantMessage | undefined) {
  return !!message?.content.some((block) =>
    block.type === 'toolCall'
      ? true
      : block.type === 'text'
        ? !!block.text
        : !!block.thinking || !!block.redacted,
  )
}

/** What the run is doing when the transcript alone does not show it; a run a pause parked says so instead. */
function LiveStatus(props: {
  id: number | undefined
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
  since,
}: {
  live: LiveState
  busy: boolean
  partial: AssistantMessage | undefined
  parked: boolean
  /** When the run started (its task first ran), for the working clock; none shows while unknown. */
  since?: number
}) {
  // Parked by a pause, nothing of the run executes, a retry's backoff and a deferred poll included: the paused line
  // replaces every other one and no clock ticks until Play.
  const paused = busy && parked
  const retry = paused ? undefined : live.generation?.retry
  const running = (live.tools ?? []).some((slot) => slot.status !== 'done')
  const idle = busy && !shows(partial) && !running
  const now = useNow(100, !paused && (!!retry || idle))
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
        {since !== undefined && now - since >= 2000 && (
          <span className="text-muted-foreground/60 tabular-nums">
            {formatDuration(now - since)}
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
