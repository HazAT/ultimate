import type { EntryRecord } from '@earendil-works/pi-durable'
import { ArrowUpIcon } from 'lucide-react'
import { useEffect, useEffectEvent, useState } from 'react'
import { Shimmer } from '@/components/ai/shimmer'
import {
  api,
  defineWebExtension,
  events,
  useConversation,
  useTranscript,
  useTranscriptScroll,
} from '@/sdk'
import { ConversationRef } from '../conversations/ui.tsx'
import { TurnAction } from './refs.ts'
import type { Turn } from './refs.ts'
import { turnLine } from './turn.ts'

/** The newest turn of the user's below `before`, `null` when there is none; it holds below any older `before` too. */
type Found = { before: number; turn: Turn | null }

/** The id of the top row on screen, and whether that row's top is on screen too: a reveal may leave it a subpixel above. */
function topRow(scroll: HTMLElement, content: HTMLElement) {
  const top = scroll.getBoundingClientRect().top
  for (const row of content.querySelectorAll(':scope > [data-entry-id]')) {
    const box = row.getBoundingClientRect()
    if (box.bottom > top)
      return { id: Number(row.getAttribute('data-entry-id')), whole: box.top > top - 1 }
  }
  return undefined
}

/** The newest turn of the user's in `entries` (oldest first, of conversation `id`) at or before entry `upTo`. */
function turnAt(entries: readonly EntryRecord[], id: number, upTo: number): Turn | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]
    if (entry.id > upTo || entry.conversationId !== id) continue
    const turn = turnLine(entry)
    if (turn) return turn
  }
  return undefined
}

/** A turn's words as the user wrote them, two lines at most: a skill as typed, a referenced message as its chip. */
function TurnWords({ turn }: { turn: Turn }) {
  return (
    <span className="line-clamp-2 min-w-0 break-words" data-turn-text>
      {turn.skill && `${turn.skill} `}
      {turn.reference && (
        <span
          className="mr-1 inline-flex max-w-[min(100%,26rem)] min-w-0 items-center rounded-sm px-0.5 align-bottom font-mono text-[11.5px] leading-4 text-foreground"
          data-turn-reference
        >
          <ConversationRef className="gap-1" id={turn.reference.conversation} />
          <span className="shrink-0 text-muted-foreground/70">/{turn.reference.entry}</span>
        </span>
      )}
      {turn.text}
    </span>
  )
}

/**
 * While the reader is scrolled up, a line at the top names the turn of the user's that the top row answers; a click
 * goes back to it. A turn older than the loaded rows is found on the server, without loading the rows between.
 */
function StickyPrompt() {
  const { scrollRef, contentRef, atBottom } = useTranscriptScroll()
  const id = useConversation((conversation) => conversation.id)
  const entries = useTranscript()
  const [shown, setShown] = useState<Turn | 'earlier'>()
  const [found, setFound] = useState<Found>()
  const [asked, setAsked] = useState<number>()
  const lookup = useEffectEvent((before: number) => {
    if (id === undefined || asked === before) return
    setAsked(before)
    api.action(TurnAction, { conversation: id, before }).then(
      ({ turn }) => setFound({ before, turn: turn ?? null }),
      // Without the stored turn the line names none; the reader still sees the loaded rows.
      () => setFound({ before, turn: null }),
    )
  })
  const place = useEffectEvent(() => {
    const scroll = scrollRef.current
    const content = contentRef.current
    const row = scroll && content && id !== undefined ? topRow(scroll, content) : undefined
    if (!row || id === undefined) return setShown(undefined)
    const loaded = turnAt(entries, id, row.id)
    if (loaded) return setShown(loaded.entryId === row.id && row.whole ? undefined : loaded)
    const oldest = entries.find((entry) => entry.conversationId === id)?.id ?? row.id
    if (found && oldest <= found.before) return setShown(found.turn ?? undefined)
    setShown('earlier')
    lookup(oldest)
  })
  useEffect(() => {
    const scroll = scrollRef.current
    const content = contentRef.current
    if (atBottom || !scroll || !content) return undefined
    let frame = 0
    const update = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => place())
    }
    update()
    scroll.addEventListener('scroll', update, { passive: true })
    const resize = new ResizeObserver(update)
    resize.observe(content)
    return () => {
      cancelAnimationFrame(frame)
      scroll.removeEventListener('scroll', update)
      resize.disconnect()
    }
  }, [atBottom, scrollRef, contentRef, entries, found])
  const turn = atBottom ? undefined : shown
  if (!turn) return null
  return (
    <div className="pt-1.5">
      <button
        className="pointer-events-auto flex w-full min-w-0 cursor-pointer items-start gap-2 rounded-md border border-border/60 bg-background/90 px-2.5 py-1 text-left text-xs text-muted-foreground shadow-sm backdrop-blur-sm hover:text-foreground disabled:cursor-default"
        data-sticky-prompt={turn === 'earlier' ? 'earlier' : turn.entryId}
        disabled={turn === 'earlier'}
        onClick={() =>
          turn !== 'earlier' &&
          events.emit('ultimate:reveal-entry', { conversationId: id, entryId: turn.entryId })
        }
        title="Scroll to this message"
        type="button"
      >
        <ArrowUpIcon className="mt-0.5 size-3 shrink-0" />
        {turn === 'earlier' ? (
          <Shimmer className="truncate">finding your message…</Shimmer>
        ) : (
          <TurnWords turn={turn} />
        )}
      </button>
    </div>
  )
}

export default defineWebExtension({ slots: { 'transcript.top': [StickyPrompt] } })
