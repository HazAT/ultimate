import type { EntryRecord } from '@earendil-works/pi-durable'
import { ArrowDownIcon, ArrowUpIcon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { cn, events, useConversation, useDocOf, useTranscript, useTranscriptScroll } from '@/sdk'
import { callerOf } from './caller.ts'
import { offscreen, openQuestion } from './data.tsx'
import type { Place, Pointer } from './data.tsx'
import { MessagesDoc } from './refs.ts'
import type { Message } from './refs.ts'

/** An open question in this transcript: its card's selector, and the entry it shows in once loaded. */
type Question = {
  key: string
  card: string
  entry?: number
  go: () => void
}

/**
 * The questions waiting on the user in conversation `id`, in transcript order: those it asked, and in @ultimate the
 * branches' questions its `board.asked` pointers show. Decided from the message log only.
 */
function questionsOf(
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
    .filter(
      (e) => e.kind === 'board.asked' && open.has((e.data as { message: number }).message ?? -1),
    )
    .map((e) => ({
      key: `p${e.id}`,
      card: `[data-message-pointer="${(e.data as { message: number }).message}"]`,
      entry: e.id,
      go: () => events.emit('ultimate:reveal-entry', { conversationId: id, entryId: e.id }),
    }))
  // A question whose response is not loaded is older than every loaded row.
  return [...own, ...pointed].toSorted((a, b) => (a.entry ?? -1) - (b.entry ?? -1))
}

/**
 * Beside the reading column, while a question waiting on the user is out of the transcript's view: an amber mark that
 * points up or down to it, and goes there on a click. In `transcript.top`, so it rides the top of the view.
 */
export function OffscreenQuestions() {
  const id = useConversation((conversation) => conversation.id)
  const messages = useDocOf(1, MessagesDoc)?.messages
  const entries = useTranscript()
  const questions = useMemo(
    () => (id === undefined || !messages ? [] : questionsOf(id, messages, entries)),
    [id, messages, entries],
  )
  // Nothing to observe on most conversations: switching to them does no work.
  return questions.length === 0 ? null : <Pointers key={id} questions={questions} />
}

/** Room left of the column a mark needs: its width and gaps; less, and it moves to the column's edge. */
const gutter = 64

function Pointers({ questions }: { questions: Question[] }) {
  const { scrollRef, contentRef } = useTranscriptScroll()
  const anchor = useRef<HTMLDivElement>(null)
  const [places, setPlaces] = useState<ReadonlyMap<string, Place>>(new Map())
  const [frame, setFrame] = useState<{ wide: boolean; bottom: number }>()

  // Each card, or the row it is folded into, against the view; a card not in the loaded rows is above them all.
  useEffect(() => {
    const scroll = scrollRef.current
    const content = contentRef.current
    if (!scroll || !content) return undefined
    const rows = [...content.querySelectorAll<HTMLElement>(':scope > [data-entry-id]')]
    const targets = new Map<Element, string>()
    const unloaded: string[] = []
    for (const question of questions) {
      const target =
        content.querySelector(question.card) ??
        (question.entry === undefined
          ? undefined
          : rows.findLast((row) => Number(row.dataset.entryId) <= question.entry!))
      if (target) targets.set(target, question.key)
      else unloaded.push(question.key)
    }
    // What the last observer saw stands until this one reports, so a new row does not blink the marks.
    setPlaces(
      (before) =>
        new Map([
          ...[...targets.values()].flatMap((key) =>
            before.has(key) ? [[key, before.get(key)!] as const] : [],
          ),
          ...unloaded.map((key) => [key, 'above'] as const),
        ]),
    )
    // An observer reports a card only when it enters or leaves its root: a jump from above the view to below it
    // crosses neither edge of the view, but always crosses the top of a root that reaches without end below it.
    const inView = new Map<Element, boolean>()
    const below = new Map<Element, boolean>()
    const report = (seen: Map<Element, boolean>) => (changes: IntersectionObserverEntry[]) => {
      for (const change of changes) seen.set(change.target, change.isIntersecting)
      setPlaces((before) => {
        const next = new Map(before)
        for (const change of changes) {
          const target = change.target
          if (!inView.has(target) || !below.has(target)) continue
          next.set(
            targets.get(target)!,
            inView.get(target) ? 'visible' : below.get(target) ? 'below' : 'above',
          )
        }
        return next
      })
    }
    const observers = [
      new IntersectionObserver(report(inView), { root: scroll }),
      new IntersectionObserver(report(below), {
        root: scroll,
        rootMargin: '0px 0px 1000000px 0px',
      }),
    ]
    for (const observer of observers) for (const target of targets.keys()) observer.observe(target)
    return () => observers.forEach((observer) => observer.disconnect())
  }, [questions, scrollRef, contentRef])

  // Whether the column leaves room on its left, and where the view's bottom is below this strip.
  useEffect(() => {
    const scroll = scrollRef.current
    const strip = anchor.current
    if (!scroll || !strip) return undefined
    // The strip rides the top of the view under what is pinned above it; `offsetTop` is that height, so the view's
    // bottom is found without reading the scroll position.
    const measure = () =>
      setFrame({
        wide: strip.getBoundingClientRect().left - scroll.getBoundingClientRect().left >= gutter,
        bottom: scroll.clientHeight - strip.offsetTop,
      })
    measure()
    const resize = new ResizeObserver(measure)
    resize.observe(scroll)
    // The strip's parent holds what `transcript.top` pins above it, which can grow.
    if (strip.parentElement) resize.observe(strip.parentElement)
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
