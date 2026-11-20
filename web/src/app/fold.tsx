import { cn } from 'cn'
import { ChevronRightIcon } from 'lucide-react'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { useCompact, useConversation } from '../sdk/hooks.ts'
import { foldKey, readFold, writeFold } from './fold-state.ts'

export { foldKey, writeFold } from './fold-state.ts'

export function useFold(card: string | number, always = false) {
  const compact = !!useCompact()
  const folds = always || compact
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

export function Fold({
  card,
  summary,
  keep = false,
  always = false,
  children,
}: {
  card: string | number
  summary: ReactNode
  keep?: boolean
  always?: boolean
  children: ReactNode
}) {
  const { folds, open, setOpen } = useFold(card, always)
  if (!folds || keep) return children
  return (
    <div className="min-w-0" data-fold={open ? 'open' : 'closed'}>
      <button
        aria-expanded={open}
        className="flex w-fit max-w-full min-w-0 cursor-pointer items-center gap-1.5 overflow-hidden font-mono text-[11px] whitespace-nowrap text-muted-foreground/70 hover:text-muted-foreground"
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
