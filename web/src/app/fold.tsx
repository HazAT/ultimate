import { cn } from 'cn'
import { ChevronRightIcon } from 'lucide-react'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { useCompact, useConversation } from '../sdk/hooks.ts'

/** Where a card's expand state lives: `ultimate.fold.<conversation>.<card>`, the card an entry id or a tool call id. */
export const foldKey = (conversation: number | undefined, card: string | number) =>
  `ultimate.fold.${conversation ?? 0}.${card}`

/** Whether the reader opened a folded card; only that deviation from the folded default is stored. */
export const readFold = (key: string) => localStorage.getItem(key) === 'open'
export function writeFold(key: string, open: boolean) {
  if (open) localStorage.setItem(key, 'open')
  else localStorage.removeItem(key)
}

/**
 * Card `card` of the shown conversation: in compact mode it `folds` to one line, closed until the reader opens it, and stays
 * open across reloads; elsewhere it never folds and is always open.
 */
export function useFold(card: string | number) {
  const folds = !!useCompact()
  const key = foldKey(
    useConversation((conversation) => conversation.id),
    card,
  )
  const [opened, setOpened] = useState(() => ({ key, open: readFold(key) }))
  const open = !folds || (opened.key === key ? opened.open : readFold(key))
  return {
    folds,
    open,
    setOpen: (next: boolean) => {
      writeFold(key, next)
      setOpened({ key, open: next })
    },
  }
}

/**
 * A card that folds in compact mode to `summary`, one quiet line like a folded run of work: what it is, who, its status. A
 * click opens the full card beneath it. Outside compact mode, or when `keep`, it renders the card alone.
 */
export function Fold({
  card,
  summary,
  keep = false,
  children,
}: {
  card: string | number
  summary: ReactNode
  keep?: boolean
  children: ReactNode
}) {
  const { folds, open, setOpen } = useFold(card)
  if (!folds || keep) return children
  return (
    <div className="min-w-0" data-fold={open ? 'open' : 'closed'}>
      <button
        aria-expanded={open}
        className="flex w-fit max-w-full min-w-0 cursor-pointer items-center gap-1.5 overflow-hidden font-mono text-[0.6875rem] whitespace-nowrap text-muted-foreground hover:text-muted-foreground"
        onClick={() => setOpen(!open)}
        type="button"
      >
        {summary}
        <ChevronRightIcon
          className={cn('size-3 shrink-0 transition-transform', open && 'rotate-90')}
        />
      </button>
      {open && <div className="mt-3">{children}</div>}
    </div>
  )
}
