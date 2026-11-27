import type { Dimension } from './dimensions.ts'

export function usd(value: number) {
  const abs = Math.abs(value)
  if (abs === 0) return '$0'
  if (abs >= 1000) return `$${Math.round(value).toLocaleString('en-US')}`
  if (abs >= 1) return `$${value.toFixed(2)}`
  if (abs >= 0.01) return `$${value.toFixed(3)}`
  return `$${value.toFixed(4)}`
}

export const signed = (value: number) =>
  Math.abs(value) < 0.00005 ? '$0' : `${value > 0 ? '+' : '−'}${usd(Math.abs(value))}`

export const whole = (value: number) =>
  value >= 10 ? `$${Math.round(value).toLocaleString('en-US')}` : usd(value)

export function usdShort(value: number) {
  if (value >= 1000) return `$${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k`
  if (value >= 10 || value === 0) return `$${Math.round(value)}`
  if (value >= 1) return `$${value.toFixed(1).replace(/\.0$/, '')}`
  return `$${value.toFixed(2)}`
}

export const percent = (share: number, digits = 1) =>
  share > 0 && share < 0.001 ? '<0.1%' : `${(share * 100).toFixed(digits)}%`

export function count(value: number) {
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B`
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`
  if (value >= 1e4) return `${(value / 1e3).toFixed(0)}k`
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`
  return String(Math.round(value))
}

const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'short' })
const monthDay = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })
export const dateLabel = (at: number) => monthDay.format(at)
export const dayLabel = (at: number) => `${weekday.format(at)} ${monthDay.format(at)}`
export const hourLabel = (at: number) => `${String(new Date(at).getHours()).padStart(2, '0')}:00`

export const parseDay = (day: string) => {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d).getTime()
}

const KIND_LABELS: Record<string, string> = {
  input: 'input',
  output: 'output',
  cacheRead: 'cache read',
  cacheWrite: 'cache write',
  unsplit: 'unsplit',
}

export function keyLabel(dimension: Dimension, key: string, label: string) {
  switch (dimension) {
    case 'kind':
      return KIND_LABELS[key] ?? key
    case 'day':
      return dayLabel(parseDay(key))
    case 'week':
      return `week of ${dateLabel(parseDay(key))}`
    case 'conversation':
    case 'tree':
    case 'agent':
    case 'model':
    case 'provider':
    case 'vendor':
    case 'family':
    case 'thinking':
    case 'cache':
    case 'prompt':
    case 'status':
    case 'tool':
    case 'hour':
  }
  return label
}
