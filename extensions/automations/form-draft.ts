import type { Automation } from './refs.ts'

export type Mode = 'cron' | 'at' | 'every'
export type FilterType = 'string' | 'number' | 'boolean'
export interface Draft {
  trigger: 'schedule' | 'script' | 'ultimate'
  ultimate: 'event' | 'context'
  event: string
  filters: Record<string, string>
  filterTypes: Record<string, FilterType>
  of: string
  above: string
  cooldownMinutes: string
  idleHours: string
  name: string
  prompt: string
  ask: string
  once: boolean
  wake: boolean
  mode: Mode
  cron: string
  tz: string
  at: string
  every: string
  agent: string
}

export const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
const pad = (value: number) => String(value).padStart(2, '0')

export function draftOf(automation?: Automation): Draft {
  const draft: Draft = {
    trigger: 'schedule',
    ultimate: 'context',
    event: '',
    filters: {},
    filterTypes: {},
    of: '@ultimate',
    above: '80',
    cooldownMinutes: '60',
    idleHours: '0',
    name: automation?.name ?? '',
    prompt: automation?.prompt ?? '',
    ask: '',
    once: true,
    wake: true,
    mode: 'cron',
    cron: '0 9 * * 1-5',
    tz: zone,
    at: 'in 30m',
    every: '1h',
    agent: automation?.agent ?? '',
  }
  if (automation?.event || automation?.condition) {
    const filters = Object.entries(automation.event?.where ?? {})
    return {
      ...draft,
      trigger: 'ultimate',
      ultimate: automation.event ? 'event' : 'context',
      event: automation.event?.name ?? '',
      filters: Object.fromEntries(filters.map(([key, value]) => [key, String(value)])),
      filterTypes: Object.fromEntries(
        filters.map(([key, value]) => [key, typeof value as FilterType]),
      ),
      of: automation.condition?.of ?? '@ultimate',
      above: String(automation.condition?.above ?? 80),
      cooldownMinutes: String((automation.condition?.cooldownMs ?? 3600000) / 60000),
      idleHours: String((automation.condition?.idleFor ?? 0) / 3600000),
    }
  }
  if (automation?.script)
    return {
      ...draft,
      trigger: 'script',
      ask: automation.script.ask,
      once: automation.script.once,
      wake: automation.subscribers.length > 0,
    }
  const schedule = automation?.schedule
  if (!schedule) return draft
  if (schedule.kind === 'cron')
    return { ...draft, mode: 'cron', cron: schedule.expr, tz: schedule.tz }
  if (schedule.kind === 'every') return { ...draft, mode: 'every', every: interval(schedule.ms) }
  const date = new Date(schedule.time)
  const local = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  return {
    ...draft,
    mode: 'at',
    at: date.getSeconds() ? `${local}:${pad(date.getSeconds())}` : local,
  }
}

function interval(ms: number) {
  for (const [unit, size] of [
    ['d', 86400000],
    ['h', 3600000],
    ['m', 60000],
  ] as const)
    if (ms % size === 0) return `${ms / size}${unit}`
  return `${ms / 1000}s`
}

export function scheduleOf(draft: Draft): string | undefined {
  if (draft.mode === 'cron')
    return draft.cron.trim() ? `cron "${draft.cron.trim()}" ${draft.tz.trim() || zone}` : undefined
  if (draft.mode === 'every') return draft.every.trim() ? `every ${draft.every.trim()}` : undefined
  const at = draft.at.trim()
  if (!at) return undefined
  if (/^in\s/.test(at)) return at.replace(/^in\s+/, 'in ')
  const local = /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d(:\d\d)?$/.test(at) && new Date(at.replace(' ', 'T'))
  return `at ${local && Number.isFinite(local.getTime()) ? local.toISOString() : at}`
}

const fieldNumber = (text: string) => (text.trim() === '' ? NaN : Number(text))

export function contextCondition(
  draft: Pick<Draft, 'of' | 'above' | 'cooldownMinutes' | 'idleHours'>,
) {
  const above = fieldNumber(draft.above)
  const cooldown = fieldNumber(draft.cooldownMinutes)
  const idle = fieldNumber(draft.idleHours)
  if (
    !/^(@[a-zA-Z0-9_-]+|#[1-9]\d*)$/.test(draft.of) ||
    !Number.isInteger(above) ||
    above < 1 ||
    above > 99 ||
    !Number.isFinite(cooldown) ||
    cooldown < 0 ||
    !Number.isFinite(idle) ||
    idle < 0
  )
    return undefined
  return {
    metric: 'context' as const,
    of: draft.of,
    above,
    cooldownMs: cooldown * 60000,
    idleFor: idle * 3600000,
  }
}

function eventTrigger(draft: Draft) {
  if (!draft.event) return undefined
  const where: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(draft.filters)) {
    if (value === '') continue
    const type = draft.filterTypes[key]
    if (type === 'boolean') {
      if (value !== 'true' && value !== 'false') return undefined
      where[key] = value === 'true'
    } else if (type === 'number') {
      const number = Number(value)
      if (!Number.isFinite(number)) return undefined
      where[key] = number
    } else where[key] = value
  }
  return { event: { name: draft.event, where } }
}

export function triggerOf(draft: Draft) {
  if (draft.trigger === 'script') {
    const ask = draft.ask.trim()
    return ask ? { ask, once: draft.once } : undefined
  }
  if (draft.trigger === 'ultimate') {
    if (draft.ultimate === 'event') return eventTrigger(draft)
    const condition = contextCondition(draft)
    return condition ? { condition } : undefined
  }
  const schedule = scheduleOf(draft)
  return schedule ? { schedule } : undefined
}
