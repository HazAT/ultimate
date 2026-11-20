import { icons } from 'lucide-react'
import { ROOT, cn, useDocOf } from '@/sdk'
import { agentMark, agentTitle } from './mark-style.ts'
import { MarksDoc } from './refs.ts'

export function useAgentTitle(name: string) {
  return agentTitle(name, useDocOf(ROOT, MarksDoc))
}

export const standingPlaceholder = (name: string | undefined, title: string, busy: boolean) =>
  name && name !== 'ultimate' && title && !busy ? `Message ${title}…` : undefined

export const AgentTitle = ({ name }: { name: string }) => useAgentTitle(name).title

export type Presence = 'working' | 'waiting' | 'awaiting' | 'idle'

export function AgentMark({
  name,
  size = 'md',
  presence,
}: {
  name: string
  size?: 'xs' | 'sm' | 'md' | 'lg'
  presence?: Presence
}) {
  const { tint, initial, Icon, iconClass, strokeWidth } = agentMark(
    name,
    useDocOf(ROOT, MarksDoc),
    icons,
  )
  return (
    <span
      aria-hidden
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center rounded-[5px] ring-1 ring-inset',
        tint,
        size === 'lg' && 'size-10 rounded-[8px] text-[18px]',
        size === 'md' && 'size-6 text-[12px]',
        size === 'sm' && 'size-4 rounded-[4px] text-[9.5px]',
        size === 'xs' && 'size-3.5 rounded-[3px] text-[8.5px]',
      )}
      data-agent-mark={name}
    >
      {initial && <span className="font-sans leading-none font-semibold">{initial}</span>}
      {Icon && <Icon className={iconClass} strokeWidth={strokeWidth} />}
      {presence && (
        <span
          className={cn(
            'absolute -right-0.5 -bottom-0.5 rounded-full ring-2 ring-sidebar',
            size === 'md' ? 'size-2' : 'size-1.5 ring-[1.5px]',
            presence === 'working'
              ? 'animate-pulse-dot bg-brand'
              : presence === 'waiting'
                ? 'bg-amber-400'
                : presence === 'awaiting'
                  ? 'bg-brand'
                  : 'bg-muted-foreground/60',
          )}
          data-presence={presence}
        />
      )}
    </span>
  )
}
