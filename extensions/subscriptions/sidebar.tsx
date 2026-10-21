import { useState } from 'react'
import { useAtomValue } from '@effect/atom-react'
import * as Atom from 'effect/reactivity/Atom'
import { ChevronRightIcon } from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn, useExtensionUiState, useNow } from '@/sdk'
import { Dot, sidebarPoll, since, states, useOpenSubscription, worst } from './parts.tsx'
import type { SubscriptionListItem } from './types.ts'

const subscriptions = Atom.readable((get) => {
  get.addFinalizer(sidebarPoll.subscribe(() => get.setSelf(sidebarPoll.snapshot())))
  return sidebarPoll.snapshot()
})

const FIRST = 5
const active = (sub: SubscriptionListItem) => sub.state !== 'stopped' && sub.state !== 'done'

/** A few words of state for a row: fewer than the surface's line, since the sidebar is narrow. */
function short(sub: SubscriptionListItem, now: number) {
  if (sub.state === 'running')
    return sub.fires > 0
      ? `fired ${sub.fires}`
      : sub.startedAt
        ? `up ${since(sub.startedAt, now)}`
        : 'running'
  return states[sub.state].word
}

/** The Agent sidebar's Watching section: active subscriptions, worst first; hidden while none is active. */
export function WatchingSection() {
  const { data } = useAtomValue(subscriptions)
  const now = useNow(10_000)
  const open = useOpenSubscription()
  const [expanded, setExpanded] = useExtensionUiState('sidebarOpen', true)
  const [all, setAll] = useState(false)
  const order = ['failed', 'investigating', 'writing', 'running']
  const list = (data ?? [])
    .filter(active)
    .toSorted((a, b) => order.indexOf(a.state) - order.indexOf(b.state))
  if (list.length === 0) return null
  const state = worst(list)!
  const alarm = state === 'failed' || state === 'investigating'
  return (
    <Collapsible
      aria-label="Watching"
      className="mb-1 flex flex-col gap-px border-b border-border/60 pb-1"
      data-sidebar-section="subscriptions"
      onOpenChange={setExpanded}
      open={expanded}
    >
      <CollapsibleTrigger className="group/watching mx-2 flex h-6 cursor-pointer items-center gap-1 rounded-md px-1 font-mono text-[9.5px] tracking-wider text-muted-foreground/70 uppercase outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring">
        <ChevronRightIcon className="size-3 transition-transform group-data-[state=open]/watching:rotate-90" />
        Watching
        <span
          className={cn(
            'rounded-full bg-sidebar-accent px-1.5 text-[9.5px] leading-4 tracking-normal tabular-nums',
            alarm ? states[state].text : 'text-foreground/80',
          )}
        >
          {list.length}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-px">
        {(all ? list : list.slice(0, FIRST)).map((sub) => (
          <button
            className="mx-2 flex h-7 min-w-0 cursor-pointer items-center gap-2 rounded-md pr-2 pl-2.5 text-left outline-none hover:bg-sidebar-accent/50 focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
            data-sidebar-subscription={sub.id}
            key={sub.id}
            onClick={() => open(sub.id)}
            title={`${sub.id} · ${sub.title}${sub.error ? `\n${sub.error}` : ''}`}
            type="button"
          >
            <Dot state={sub.state} />
            <span className="min-w-0 flex-1 truncate text-[12.5px] text-foreground/85">
              {sub.title}
            </span>
            <span
              className={cn(
                'shrink-0 font-mono text-[10px]',
                sub.state === 'running' ? 'text-muted-foreground' : states[sub.state].text,
              )}
            >
              {short(sub, now)}
            </span>
          </button>
        ))}
        {list.length > FIRST && (
          <button
            className="mx-2 h-5 cursor-pointer rounded-md pl-[26px] text-left font-mono text-[10px] text-muted-foreground/70 outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
            onClick={() => setAll(!all)}
            type="button"
          >
            {all ? 'fewer' : `+${list.length - FIRST} more`}
          </button>
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}
