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
import { api, cn, formatDuration, formatTime, useUltimate } from '@/sdk'
import { ListAction } from './refs.ts'
import type { Automation, AutomationListItem, Run, Schedule } from './refs.ts'

/** A one-shot schedule whose time has passed: resuming it would fire at once, so its switch stays off. */
export const spent = (automation: Automation, now: number) =>
  automation.schedule?.kind === 'at' && Date.parse(automation.schedule.time) <= now

/** `in 3s`, `in 12m`, `in 3h 12m`, `in 2d 4h`, then a short date. */
export function until(at: number, now: number) {
  const seconds = Math.max(0, Math.round((at - now) / 1000))
  if (seconds < 1) return 'now'
  if (seconds < 60) return `in ${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `in ${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `in ${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ''}`
  const days = Math.floor(hours / 24)
  if (days < 7) return `in ${days}d${hours % 24 ? ` ${hours % 24}h` : ''}`
  return `on ${new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
}

/** `now`, `12s ago`, `5m ago`, `3h ago`, `2d ago`, then a short date. */
export function ago(at: number, now: number) {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 2) return 'now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** A clock time, with the date when it is not today: `09:00:03`, `Oct 6, 09:00`. */
export function clock(at: number, now: number) {
  const date = new Date(at)
  return date.toDateString() === new Date(now).toDateString()
    ? formatTime(date, true)
    : date.toLocaleString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      })
}

/** The backend's words for a schedule; a one-shot reads as a local time rather than its ISO instant. */
export const words = (schedule: Schedule, description: string, now: number) =>
  schedule.kind === 'at' ? `Once, ${clock(Date.parse(schedule.time), now)}` : description

export const full = (at: number) =>
  new Date(at).toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'long' })

const statuses = {
  running: [LoaderCircleIcon, 'animate-spin text-brand', 'running'],
  done: [CheckIcon, 'text-success', 'done'],
  failed: [XIcon, 'text-error', 'failed'],
  aborted: [MinusCircleIcon, 'text-warning', 'stopped'],
  skipped: [SkipForwardIcon, 'text-muted-foreground', 'skipped'],
} as const

export const statusLabel = (status: Run['status']) => statuses[status][2]

export function RunIcon({ status, className }: { status: Run['status']; className?: string }) {
  const [Icon, tone, label] = statuses[status]
  return <Icon aria-label={label} className={cn('size-3 shrink-0', tone, className)} />
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

/**
 * What an automation is doing, in one word, whatever its trigger: a script's lifecycle, a prompt run working or failed,
 * or a schedule armed, paused or spent. Red and yellow need attention; green is armed; purple works; grey rests.
 */
export type Look =
  | 'failed'
  | 'investigating'
  | 'writing'
  | 'working'
  | 'watching'
  | 'scheduled'
  | 'armed'
  | 'waiting'
  | 'paused'
  | 'done'
export const looks: Record<
  Look,
  { dot: string; text: string; word: string; rank: number; busy?: boolean }
> = {
  failed: { dot: 'bg-error', text: 'text-error', word: 'failed', rank: 0 },
  investigating: {
    dot: 'bg-warning',
    text: 'text-warning',
    word: 'investigating',
    rank: 1,
    busy: true,
  },
  writing: { dot: 'bg-brand', text: 'text-brand', word: 'writing', rank: 2, busy: true },
  working: { dot: 'bg-brand', text: 'text-brand', word: 'working', rank: 2, busy: true },
  watching: { dot: 'bg-success', text: 'text-success', word: 'watching', rank: 3 },
  scheduled: { dot: 'bg-success', text: 'text-success', word: 'scheduled', rank: 3 },
  armed: { dot: 'bg-success', text: 'text-success', word: 'armed', rank: 3 },
  waiting: { dot: 'bg-success', text: 'text-success', word: 'waiting', rank: 3 },
  paused: { dot: 'bg-muted-foreground/50', text: 'text-muted-foreground', word: 'paused', rank: 4 },
  done: { dot: 'bg-muted-foreground/50', text: 'text-muted-foreground', word: 'done', rank: 5 },
}

export function lookOf(automation: Automation, now: number): Look {
  const state = automation.script?.state
  if (state === 'failed' || state === 'investigating' || state === 'writing') return state
  const last = automation.runs.at(-1)?.status
  if (last === 'running') return 'working'
  // A failed run of a paused automation was already dealt with by pausing it; a fired one-shot script is disabled by
  // its fire, not by anyone, so its failed run still needs attention.
  if (last === 'failed' && (automation.enabled || state === 'done')) return 'failed'
  if (state === 'running') return 'watching'
  if (state === 'done') return 'done'
  if (automation.enabled) {
    if (automation.condition) return automation.condition.armed ? 'armed' : 'waiting'
    if (automation.event) return 'watching'
    return 'scheduled'
  }
  return spent(automation, now) ? 'done' : 'paused'
}

export const attention = (look: Look) => look === 'failed' || look === 'investigating'
/** Enabled, working or needing attention: what the sidebar and the chip count. */
export const active = (automation: Automation, now: number) =>
  looks[lookOf(automation, now)].rank <= 3

/** Worst first, then newest. */
export const worstFirst = <T extends Automation>(list: readonly T[], now: number) =>
  list.toSorted(
    (a, b) => looks[lookOf(a, now)].rank - looks[lookOf(b, now)].rank || b.createdAt - a.createdAt,
  )

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
      data-status={
        busy ? 'working' : look === 'failed' || look === 'paused' || look === 'done' ? look : 'idle'
      }
      role="img"
    />
  )
}

/** A clock for schedules, radar for scripts, bolt for Ultimate events and context. */
export function KindIcon({
  automation,
  className,
}: {
  automation: Automation
  className?: string
}) {
  const kind = automation.event
    ? 'event'
    : automation.condition
      ? 'context'
      : automation.script
        ? 'script'
        : 'schedule'
  const Icon =
    automation.event || automation.condition
      ? ZapIcon
      : automation.script
        ? RadarIcon
        : CalendarClockIcon
  return (
    <Icon aria-label={kind} className={cn('size-3 shrink-0 text-muted-foreground/70', className)} />
  )
}

/** `12s`, `5m`, `3h 12m`, `2d 4h`: how long since `at`, in whole units. */
export function since(at: number, now: number) {
  const seconds = Math.max(0, Math.floor((now - at) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ''}`
  const days = Math.floor(hours / 24)
  return `${days}d${hours % 24 ? ` ${hours % 24}h` : ''}`
}

const fired = (automation: Automation, now: number) =>
  automation.fires > 0
    ? `fired ${automation.fires}${automation.lastFireAt ? ` · ${ago(automation.lastFireAt, now)}` : ''}`
    : undefined

/** The one line under a name: what it is doing right now and what it did last. */
export function stateLine(automation: Automation, now: number): string {
  const look = lookOf(automation, now)
  const script = automation.script
  const last = automation.runs.at(-1)
  if (automation.condition && !attention(look) && look !== 'working') {
    const condition = automation.condition
    return condition.armed
      ? condition.value === undefined
        ? 'context not seen yet'
        : `${Math.round(condition.value)}% now`
      : condition.above <= 10
        ? `won't re-arm${automation.lastFireAt ? ` · fired ${clock(automation.lastFireAt, now)}` : ''}`
        : `${automation.lastFireAt ? `fired ${clock(automation.lastFireAt, now)} · ` : ''}re-arms below ${condition.above - 10}%`
  }
  if (automation.event && !attention(look) && look !== 'working')
    return automation.fires
      ? `fired ${automation.fires} ${automation.fires === 1 ? 'time' : 'times'}${automation.lastFireAt ? ` · last ${clock(automation.lastFireAt, now)}` : ''}`
      : 'never fired'
  const parts: (string | false | undefined)[] = []
  if (look === 'failed')
    parts.push(
      script?.state === 'failed'
        ? (script.error ?? 'the script failed')
        : `last run failed ${last ? ago(last.finishedAt ?? last.firedAt, now) : ''}`,
    )
  else if (look === 'investigating') parts.push('the watcher is repairing the script')
  else if (look === 'writing') parts.push('the watcher is writing the script')
  else if (look === 'working')
    parts.push(`run working · ${formatDuration(Math.max(0, now - last!.firedAt))}`)
  else if (look === 'watching') {
    if (script?.startedAt) parts.push(`up ${since(script.startedAt, now)}`)
    parts.push(fired(automation, now) ?? 'not fired yet')
  } else if (look === 'scheduled') {
    parts.push(
      automation.nextAt !== undefined ? `next ${until(automation.nextAt, now)}` : 'scheduling…',
    )
    if (last) parts.push(`${statusLabel(last.status)} ${ago(last.finishedAt ?? last.firedAt, now)}`)
  } else {
    // The state word already stands before this line: add only what happened.
    if (script) parts.push(fired(automation, now) ?? 'never fired')
    else if (last)
      parts.push(`last ${statusLabel(last.status)} ${ago(last.finishedAt ?? last.firedAt, now)}`)
  }
  return parts.filter(Boolean).join(' · ')
}

/** Browser-safe wording for the two domain triggers. */
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

type Polled = { data?: AutomationListItem[]; error?: unknown }
/**
 * One list poll for the whole page: the chip, the sidebar, the panel and the cards share it, and it runs at the fastest
 * rate any of them asks for.
 */
const poll = {
  state: {} as Polled,
  listeners: new Set<() => void>(),
  rates: new Map<symbol, number>(),
  timer: undefined as ReturnType<typeof setInterval> | undefined,
  rate: 0,
  loading: undefined as Promise<void> | undefined,
}
function publish(state: Polled) {
  poll.state = state
  for (const listener of poll.listeners) listener()
}
/** Fetch the list now; a fetch in flight is reused. Call it after an action changes an automation. */
export function refreshAutomations() {
  poll.loading ??= api
    .action(ListAction)
    .then((data) => publish({ data }))
    .catch((error: unknown) => publish({ ...poll.state, error }))
    .finally(() => (poll.loading = undefined))
  return poll.loading
}
function reschedule() {
  const rate = Math.min(...poll.rates.values())
  if (rate === poll.rate) return
  clearInterval(poll.timer)
  poll.rate = rate
  poll.timer = Number.isFinite(rate)
    ? setInterval(() => void refreshAutomations(), rate)
    : undefined
}
const listen = (listener: () => void) => {
  poll.listeners.add(listener)
  return () => void poll.listeners.delete(listener)
}

/** The automations, fetched again every `ms` while this component is mounted (`false`: once). */
export function useAutomations(ms: number | false): Polled {
  useEffect(() => {
    const key = Symbol()
    poll.rates.set(key, ms === false ? Infinity : ms)
    reschedule()
    // oxlint-disable-next-line typescript/no-floating-promises -- refreshAutomations catches failures and publishes them in poll.state.error.
    void refreshAutomations()
    return () => {
      poll.rates.delete(key)
      reschedule()
    }
  }, [ms])
  return useSyncExternalStore(listen, () => poll.state)
}

/** Opens the Automations panel, on the Agent surface: other surfaces, such as System, have no panels. */
export function openAutomationsPanel(shell: {
  showSurface: (id: string) => void
  openPanel: (id?: string) => void
}) {
  shell.showSurface('agent')
  shell.openPanel('automations')
}

/**
 * Opens automation `id`: a script's watcher conversation in the middle and the panel beside it, which then shows its
 * script; a schedule opens the panel on the list. An id the list does not know yet (a card for one just created) is
 * looked up first.
 */
export function useOpenAutomation() {
  const { switchConversation, ...shell } = useUltimate()
  const watcher = (id: string) =>
    poll.state.data?.find((automation) => automation.id === id)?.script?.conversationId
  const show = (id: string) => {
    const to = watcher(id)
    if (to !== undefined) switchConversation(to)
    // After the switch, which closes an overlaid panel on a phone.
    openAutomationsPanel(shell)
  }
  return (id: string) => {
    if (poll.state.data?.some((automation) => automation.id === id)) return show(id)
    // oxlint-disable-next-line typescript/no-floating-promises -- refreshAutomations catches failures and publishes them in poll.state.error.
    void refreshAutomations().then(() => show(id))
  }
}

/** A small section heading with a meta value on the right, as in the Agents and Extensions panels. */
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
