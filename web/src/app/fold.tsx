import type { ConversationId } from '@earendil-works/pi-durable'
import { cn } from 'cn'
import { ChevronRightIcon } from 'lucide-react'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { uiState } from '../sdk/client.ts'
import { useCompact, useConversation, useUiState } from '../sdk/hooks.ts'

const AGENT_TRAFFIC = 'fold.agentTraffic'

export const agentTrafficFolds = () => uiState.get(AGENT_TRAFFIC) !== false

export const toggleAgentTrafficFolds = () => uiState.set(AGENT_TRAFFIC, !agentTrafficFolds())

export const foldKey = (conversation: ConversationId | undefined, card: string | number) =>
  `ultimate.fold.${conversation ?? 0}.${card}`

export const readFold = (key: string) => localStorage.getItem(key) === 'open'
export function writeFold(key: string, open: boolean) {
  if (open) localStorage.setItem(key, 'open')
  else localStorage.removeItem(key)
}

export function useFold(card: string | number, always = false, agent = false) {
  const compact = !!useCompact()
  const [agentTraffic] = useUiState<boolean>(AGENT_TRAFFIC, true)
  const folds = always || compact || (agent && agentTraffic)
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
  agent = false,
  children,
}: {
  card: string | number
  summary: ReactNode
  keep?: boolean
  always?: boolean
  agent?: boolean
  children: ReactNode
}) {
  const { folds, open, setOpen } = useFold(card, always, agent)
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
