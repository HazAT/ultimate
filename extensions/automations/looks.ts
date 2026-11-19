import type { Automation, Run } from './refs.ts'

export const spent = (automation: Automation, now: number) =>
  automation.schedule?.kind === 'at' && Date.parse(automation.schedule.time) <= now

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

function ago(at: number, now: number) {
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

type FormatTime = (at: Date, seconds: boolean) => string

export function clock(at: number, now: number, formatTime: FormatTime) {
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

const statusLabels = {
  running: 'running',
  done: 'done',
  failed: 'failed',
  aborted: 'stopped',
  skipped: 'skipped',
} satisfies Record<Run['status'], string>

export const statusLabel = (status: Run['status']) => statusLabels[status]

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
  const failedRunStillNeedsAttention = last === 'failed' && (automation.enabled || state === 'done')
  if (failedRunStillNeedsAttention) return 'failed'
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
export const active = (automation: Automation, now: number) =>
  looks[lookOf(automation, now)].rank <= 3

export const worstFirst = <T extends Automation>(list: readonly T[], now: number) =>
  list.toSorted(
    (a, b) => looks[lookOf(a, now)].rank - looks[lookOf(b, now)].rank || b.createdAt - a.createdAt,
  )

export function dotStatus(look: Look) {
  if (looks[look].busy) return 'working'
  return look === 'failed' || look === 'paused' || look === 'done' ? look : 'idle'
}

export function automationKind(automation: Automation) {
  return automation.event
    ? 'event'
    : automation.condition
      ? 'context'
      : automation.script
        ? 'script'
        : 'schedule'
}

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

export function stateLine(
  automation: Automation,
  now: number,
  formatTime: FormatTime,
  formatDuration: (ms: number) => string,
): string {
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
        ? `won't re-arm${automation.lastFireAt ? ` · fired ${clock(automation.lastFireAt, now, formatTime)}` : ''}`
        : `${automation.lastFireAt ? `fired ${clock(automation.lastFireAt, now, formatTime)} · ` : ''}re-arms below ${condition.above - 10}%`
  }
  if (automation.event && !attention(look) && look !== 'working')
    return automation.fires
      ? `fired ${automation.fires} ${automation.fires === 1 ? 'time' : 'times'}${automation.lastFireAt ? ` · last ${clock(automation.lastFireAt, now, formatTime)}` : ''}`
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
    if (script) parts.push(fired(automation, now) ?? 'never fired')
    else if (last)
      parts.push(`last ${statusLabel(last.status)} ${ago(last.finishedAt ?? last.firedAt, now)}`)
  }
  return parts.filter(Boolean).join(' · ')
}
