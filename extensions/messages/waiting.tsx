import type { EntryRecord } from '@earendil-works/pi-durable'
import { ROOT } from '@/sdk'
import { ArrowDownIcon, ArrowUpIcon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { cn, events, useConversation, useDocOf, useTranscript, useTranscriptScroll } from '@/sdk'
import { callerOf } from './caller.ts'
import { offscreen, openQuestion } from './data.ts'
import type { Place, Pointer } from './data.ts'
import { MessagesDoc } from './refs.ts'
import { AskedEntry } from './entries.ts'
import type { Message } from './refs.ts'

type Question = {
  key: string
  card: string
  entry?: number
  go: () => void
}

export function questionsOf(
  id: number,
  messages: readonly Message[],
  entries: readonly EntryRecord[],
): Question[] {
  const open = new Map(messages.filter(openQuestion).map((m) => [m.id, m]))
  if (open.size === 0) return []
  const own = [...open.values()]
    .filter((m) => m.from === id)
    .map((m) => ({
      key: `m${m.id}`,
      card: `[data-message-outgoing="${m.id}"]`,
      entry: m.call ? callerOf(entries, m.call.split('/')[0])?.id : undefined,
      go: () => events.emit('messages:open', { conversation: id, message: m.id }),
    }))
  const pointed = entries
    .filter((candidate) => AskedEntry.is(candidate))
    .filter((e) => e.conversationId === id && open.has(e.data.message ?? -1))
    .map((e) => ({
      key: `p${e.id}`,
      card: `[data-message-pointer="${e.data.message}"]`,
      entry: e.id,
      go: () => events.emit('ultimate:reveal-entry', { conversationId: id, entryId: e.id }),
    }))

  const beforeEveryLoadedEntry = -1
  return [...own, ...pointed].toSorted(
    (a, b) => (a.entry ?? beforeEveryLoadedEntry) - (b.entry ?? beforeEveryLoadedEntry),
  )
}

export function OffscreenQuestions() {
  const id = useConversation((conversation) => conversation.id)
  const messages = useDocOf(ROOT, MessagesDoc)?.messages
  const entries = useTranscript()
  const questions = useMemo(
    () => (id === undefined || !messages ? [] : questionsOf(id, messages, entries)),
    [id, messages, entries],
  )

  return questions.length === 0 ? null : <Pointers key={id} questions={questions} />
}

const markWidthWithGapsPx = 64

function Pointers({ questions }: { questions: Question[] }) {
  const { scrollRef, contentRef } = useTranscriptScroll()
  const anchor = useRef<HTMLDivElement>(null)
  const [places, setPlaces] = useState<ReadonlyMap<string, Place>>(new Map())
  const [frame, setFrame] = useState<{ wide: boolean; bottom: number }>()

  useEffect(() => {
    const scroll = scrollRef.current
    const content = contentRef.current
    if (!scroll || !content) return undefined
    const rows = [...content.querySelectorAll<HTMLElement>(':scope > [data-entry-id]')]
    const targets = new Map<Element, string>()
    const unloadedQuestionsAboveTranscript: string[] = []
    for (const question of questions) {
      const target =
        content.querySelector(question.card) ??
        (question.entry === undefined
          ? undefined
          : rows.findLast((row) => Number(row.dataset.entryId) <= question.entry!))
      if (target) targets.set(target, question.key)
      else unloadedQuestionsAboveTranscript.push(question.key)
    }

    setPlaces(
      (lastObserverPlacesUntilFirstReport) =>
        new Map([
          ...[...targets.values()].flatMap((key) =>
            lastObserverPlacesUntilFirstReport.has(key)
              ? [[key, lastObserverPlacesUntilFirstReport.get(key)!] as const]
              : [],
          ),
          ...unloadedQuestionsAboveTranscript.map((key) => [key, 'above'] as const),
        ]),
    )

    const intersectsViewport = new Map<Element, boolean>()
    const intersectsRootExtendedBelow = new Map<Element, boolean>()
    const report = (seen: Map<Element, boolean>) => (changes: IntersectionObserverEntry[]) => {
      for (const change of changes) seen.set(change.target, change.isIntersecting)
      setPlaces((before) => {
        const next = new Map(before)
        for (const change of changes) {
          const target = change.target
          if (!intersectsViewport.has(target) || !intersectsRootExtendedBelow.has(target)) continue
          next.set(
            targets.get(target)!,
            intersectsViewport.get(target)
              ? 'visible'
              : intersectsRootExtendedBelow.get(target)
                ? 'below'
                : 'above',
          )
        }
        return next
      })
    }
    const jumpDetectingRootMargin = '0px 0px 1000000px 0px'
    const observers = [
      new IntersectionObserver(report(intersectsViewport), { root: scroll }),
      new IntersectionObserver(report(intersectsRootExtendedBelow), {
        root: scroll,
        rootMargin: jumpDetectingRootMargin,
      }),
    ]
    for (const observer of observers) for (const target of targets.keys()) observer.observe(target)
    return () => observers.forEach((observer) => observer.disconnect())
  }, [questions, scrollRef, contentRef])

  useEffect(() => {
    const scroll = scrollRef.current
    const strip = anchor.current
    if (!scroll || !strip) return undefined

    const measureBottomFromPinnedStripOffset = () =>
      setFrame({
        wide:
          strip.getBoundingClientRect().left - scroll.getBoundingClientRect().left >=
          markWidthWithGapsPx,
        bottom: scroll.clientHeight - strip.offsetTop,
      })
    measureBottomFromPinnedStripOffset()
    const resize = new ResizeObserver(measureBottomFromPinnedStripOffset)
    resize.observe(scroll)

    let pinned = strip.parentElement
    while (pinned && getComputedStyle(pinned).display === 'contents') pinned = pinned.parentElement
    if (pinned) resize.observe(pinned)
    return () => resize.disconnect()
  }, [scrollRef])

  const { up, down } = offscreen(
    questions.map((q) => ({ key: q, place: places.get(q.key) ?? 'visible' })),
  )
  return (
    <div className="relative h-0" data-ui="offscreen-questions" ref={anchor}>
      {frame && up && <Mark direction="up" pointer={up} wide={frame.wide} />}
      {frame && down && (
        <Mark
          direction="down"
          pointer={down}
          style={{ top: frame.bottom - (frame.wide ? 48 : 80) }}
          wide={frame.wide}
        />
      )}
    </div>
  )
}

function Mark({
  direction,
  pointer,
  wide,
  style,
}: {
  direction: 'up' | 'down'
  pointer: Pointer<Question>
  wide: boolean
  style?: CSSProperties
}) {
  const Arrow = direction === 'up' ? ArrowUpIcon : ArrowDownIcon
  const label = `${pointer.count === 1 ? 'A question awaits' : `${pointer.count} questions await`} your reply ${direction === 'up' ? 'above' : 'below'}`
  return (
    <button
      aria-label={label}
      className={cn(
        'pointer-events-auto absolute flex h-7 animate-fade-in cursor-pointer items-center rounded-full bg-background font-mono text-[11px] shadow-sm',
        wide ? 'right-full mr-3' : 'left-1/2 -translate-x-1/2',
        direction === 'up' && 'top-3',
      )}
      onClick={pointer.nearest.go}
      style={style}
      title={label}
      type="button"
    >
      <span
        className={cn(
          'flex h-full items-center gap-1 rounded-full bg-amber-500/15 text-amber-700 hover:bg-amber-500/25 dark:text-amber-300',
          wide && pointer.count === 1 ? 'w-7 justify-center' : 'px-2.5',
        )}
      >
        <Arrow className="size-3.5" />
        {wide
          ? pointer.count > 1 && pointer.count
          : `${pointer.count > 1 ? `${pointer.count} ` : ''}awaiting your reply`}
      </span>
    </button>
  )
}
