import {
  CalendarClockIcon,
  CheckIcon,
  LoaderCircleIcon,
  MinusCircleIcon,
  RadarIcon,
  SkipForwardIcon,
  XIcon,
  ZapIcon,
} from 'lucide-react'
import { useEffect, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { api, cn, formatTime, useUltimate } from '@/sdk'
import { automationKind, clock, dotStatus, looks, statusLabel } from './looks.ts'
import type { Look } from './looks.ts'
import { openAutomation } from './navigation.ts'
import { get, subscribe, want } from './poll.ts'
import type { Automation, Run, Schedule } from './refs.ts'

export const words = (schedule: Schedule, description: string, now: number) =>
  schedule.kind === 'at'
    ? `Once, ${clock(Date.parse(schedule.time), now, formatTime)}`
    : description

export const full = (at: number) =>
  new Date(at).toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'long' })

const statuses = {
  running: [LoaderCircleIcon, 'animate-spin text-brand'],
  done: [CheckIcon, 'text-success'],
  failed: [XIcon, 'text-error'],
  aborted: [MinusCircleIcon, 'text-warning'],
  skipped: [SkipForwardIcon, 'text-muted-foreground'],
} as const

export function RunIcon({ status, className }: { status: Run['status']; className?: string }) {
  const [Icon, tone] = statuses[status]
  return (
    <Icon aria-label={statusLabel(status)} className={cn('size-3 shrink-0', tone, className)} />
  )
}

export function BusyDot({ className }: { className?: string }) {
  return (
    <span className={cn('size-1.5 shrink-0 animate-pulse-dot rounded-full bg-brand', className)} />
  )
}

export function Tag({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'shrink-0 rounded-sm border border-border/80 px-1 font-mono text-[10px] leading-4 text-muted-foreground',
        className,
      )}
    >
      {children}
    </span>
  )
}

export function Dot({ look, className }: { look: Look; className?: string }) {
  const { dot, word, busy } = looks[look]
  return (
    <span
      aria-label={word}
      className={cn(
        'inline-block size-1.5 shrink-0 rounded-full',
        dot,
        busy && 'animate-pulse-dot',
        className,
      )}
      data-status={dotStatus(look)}
      role="img"
    />
  )
}

const kindIcons = {
  event: ZapIcon,
  context: ZapIcon,
  script: RadarIcon,
  schedule: CalendarClockIcon,
}

export function KindIcon({
  automation,
  className,
}: {
  automation: Automation
  className?: string
}) {
  const kind = automationKind(automation)
  const Icon = kindIcons[kind]
  return (
    <Icon aria-label={kind} className={cn('size-3 shrink-0 text-muted-foreground/70', className)} />
  )
}

export function triggerWords(automation: Automation) {
  if (automation.event) {
    const filters = Object.entries(automation.event.where ?? {}).map(
      ([key, value]) => `${key}=${value}`,
    )
    return `on ${automation.event.name}${filters.length ? ` where ${filters.join(', ')}` : ''}`
  }
  if (automation.condition)
    return `when ${automation.condition.of} context ≥ ${automation.condition.above}%`
  return ''
}

export function useAutomations(ms: number | false) {
  useEffect(() => want(ms, api.action), [ms])
  return useSyncExternalStore(subscribe, get)
}

export function useOpenAutomation() {
  const shell = useUltimate()
  return (id: string) => openAutomation(id, shell, api.action)
}

export function Heading({
  children,
  meta,
  className,
}: {
  children: ReactNode
  meta?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex items-center gap-2 section-label', className)}>
      {children}
      {meta !== undefined && (
        <span className="ml-auto truncate pl-2 text-muted-foreground/70">{meta}</span>
      )}
    </div>
  )
}
