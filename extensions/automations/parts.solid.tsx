import {
  CalendarClock,
  Check,
  CircleMinus,
  LoaderCircle,
  Radar,
  SkipForward,
  X,
  Zap,
} from '@lucide/solid'
import { Dynamic } from '@solidjs/web'
import type { JSX } from '@solidjs/web'
import { cn } from '@/sdk/solid'
import { automationKind, dotStatus, looks, statusLabel } from './looks.web.ts'
import type { Look } from './looks.web.ts'
import type { Automation, Run } from './refs.ts'

const statuses = {
  running: [LoaderCircle, 'animate-spin text-brand'],
  done: [Check, 'text-success'],
  failed: [X, 'text-error'],
  aborted: [CircleMinus, 'text-warning'],
  skipped: [SkipForward, 'text-muted-foreground'],
} as const

export function RunIcon(props: { status: Run['status'] }) {
  return (
    <Dynamic
      component={statuses[props.status][0]}
      aria-label={statusLabel(props.status)}
      class={cn('size-3 shrink-0', statuses[props.status][1])}
    />
  )
}

export function BusyDot(props: { class?: string }) {
  return (
    <span class={cn('size-1.5 shrink-0 animate-pulse-dot rounded-full bg-brand', props.class)} />
  )
}

export function Tag(props: { children: JSX.Element }) {
  return (
    <span class="shrink-0 rounded-sm border border-border/80 px-1 font-mono text-[10px] leading-4 text-muted-foreground">
      {props.children}
    </span>
  )
}

export function Dot(props: { look: Look; class?: string }) {
  const appearance = () => looks[props.look]
  return (
    <svg
      aria-label={appearance().word}
      class={cn(
        'inline-block size-1.5 shrink-0 rounded-full',
        appearance().dot,
        appearance().busy && 'animate-pulse-dot',
        props.class,
      )}
      data-status={dotStatus(props.look)}
    >
      <title>{appearance().word}</title>
    </svg>
  )
}

const kindIcons = { event: Zap, context: Zap, script: Radar, schedule: CalendarClock }

export function KindIcon(props: { automation: Automation }) {
  const kind = () => automationKind(props.automation)
  return (
    <Dynamic
      component={kindIcons[kind()]}
      aria-label={kind()}
      class="size-3 shrink-0 text-muted-foreground/70"
    />
  )
}

export function Heading(props: { children: JSX.Element; meta?: JSX.Element; class?: string }) {
  return (
    <div class={cn('flex items-center gap-2 section-label', props.class)}>
      {props.children}
      <span class="ml-auto truncate pl-2 text-muted-foreground/70">{props.meta}</span>
    </div>
  )
}
