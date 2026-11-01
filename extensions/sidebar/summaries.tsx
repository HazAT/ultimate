import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { formatAgo, formatTime, useAction } from '@/sdk'
import { SummariesAction } from '../conversations/ui.tsx'

/**
 * A branch row with its summary history on hover: the latest first, older ones below in a list that scrolls inside,
 * also with ↑/↓ while the row has focus. Read when it opens. Touch has no hover, so phones show none.
 */
export function SummaryHistory({ id, children }: { id: number; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const list = useRef<HTMLOListElement>(null)
  return (
    <HoverCard closeDelay={100} onOpenChange={setOpen} open={open} openDelay={600}>
      <HoverCardTrigger
        asChild
        onKeyDown={(event) => {
          if (!open || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return
          event.preventDefault()
          list.current?.scrollBy({ top: event.key === 'ArrowDown' ? 48 : -48 })
        }}
      >
        {children}
      </HoverCardTrigger>
      <HoverCardContent
        align="start"
        className="w-80 p-0"
        collisionPadding={8}
        data-summary-history={id}
        side="right"
      >
        <History id={id} list={list} />
      </HoverCardContent>
    </HoverCard>
  )
}

function History({ id, list }: { id: number; list: React.RefObject<HTMLOListElement | null> }) {
  const { data, loading } = useAction(SummariesAction, { id }, { onError: () => {} })
  const now = Date.now()
  if (!data)
    return (
      <p className="px-3 py-2 text-[11px] text-muted-foreground">
        {loading ? 'Loading summaries…' : 'Summaries unavailable'}
      </p>
    )
  if (!data.length)
    return <p className="px-3 py-2 text-[11px] text-muted-foreground">No summary yet</p>
  return (
    <ol
      aria-label="Summary history"
      className="max-h-72 overflow-y-auto overscroll-contain py-1"
      ref={list}
    >
      {data.map((record, index) => (
        <li
          className="border-b border-border/50 px-3 py-1.5 last:border-b-0"
          key={`${record.at ?? 'now'}-${record.summary}`}
        >
          <div className="flex items-baseline gap-2 font-mono text-[10px] text-muted-foreground/80">
            {index === 0 && <span className="text-foreground/80">Latest</span>}
            {record.at !== undefined && (
              <time
                className="ml-auto"
                dateTime={new Date(record.at).toISOString()}
                title={new Date(record.at).toLocaleString()}
              >
                {formatAgo(record.at, now)} · {formatTime(record.at)}
              </time>
            )}
          </div>
          <p
            className={
              index === 0
                ? 'text-xs leading-relaxed break-words text-foreground/90'
                : 'text-xs leading-relaxed break-words text-muted-foreground'
            }
          >
            {record.summary}
          </p>
        </li>
      ))}
    </ol>
  )
}
