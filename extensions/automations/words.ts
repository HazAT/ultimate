import { clock } from './looks.ts'
import type { Automation, Schedule } from './refs.ts'

export const automationLabel = (automation: Pick<Automation, 'name' | 'id'>) =>
  `${automation.name} (${automation.id})`

export const words = (
  schedule: Schedule,
  description: string,
  now: number,
  formatTime: Parameters<typeof clock>[2],
) =>
  schedule.kind === 'at'
    ? `Once, ${clock(Date.parse(schedule.time), now, formatTime)}`
    : description

export const full = (at: number) =>
  new Date(at).toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'long' })

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

export function actions(automation: Automation) {
  const [first, ...others] = automation.subscribers
  const target = others.length
    ? `${automation.subscribers.length} conversations`
    : typeof first === 'number'
      ? `#${first}`
      : first
  return [
    automation.script && (automation.script.once ? 'once' : 'every time'),
    target && `wakes ${target}`,
    automation.prompt && 'runs a prompt',
  ]
    .filter(Boolean)
    .join(' · ')
}
