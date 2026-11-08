import type { Schedule } from './types.ts'
export type { Schedule } from './types.ts'

function duration(text: string) {
  const match = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/.exec(text)
  if (!match) throw new Error('Use a duration such as 30m, 2h, or 1d')
  return Number(match[1]) * { s: 1000, m: 60000, h: 3600000, d: 86400000 }[match[2]]!
}

function field(text: string, min: number, max: number) {
  const values = new Set<number>()
  for (const item of text.split(',')) {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(item)
    if (!match) throw new Error(`Invalid cron field: ${text}`)
    const step = Number(match[2] ?? 1)
    const [start, end] =
      match[1] === '*'
        ? [min, max]
        : match[1].includes('-')
          ? match[1].split('-').map(Number)
          : [Number(match[1]), match[2] ? max : Number(match[1])]
    if (step < 1 || start < min || end > max || start > end)
      throw new Error(`Invalid cron field: ${text}`)
    for (let value = start; value <= end; value += step) values.add(value)
  }
  return values
}

function cron(expr: string, tz: string) {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) throw new Error('Cron requires five fields')
  const fields = parts.map((part, i) => field(part, [0, 0, 1, 1, 0][i], [59, 23, 31, 12, 7][i]))
  if (fields[4].has(7)) fields[4].add(0)
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    minute: 'numeric',
    hour: 'numeric',
    day: 'numeric',
    month: 'numeric',
    weekday: 'short',
    year: 'numeric',
    hourCycle: 'h23',
  })
  const local = (time: number) => {
    const p = Object.fromEntries(
      formatter.formatToParts(time).map((part) => [part.type, part.value]),
    )
    const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday)
    const day = fields[2].has(Number(p.day))
    const week = fields[4].has(dow)
    return {
      wall: Date.UTC(
        Number(p.year),
        Number(p.month) - 1,
        Number(p.day),
        Number(p.hour),
        Number(p.minute),
      ),
      minute: Number(p.minute),
      hour: Number(p.hour),
      dateMatches:
        fields[3].has(Number(p.month)) &&
        (parts[2].startsWith('*') || parts[4].startsWith('*') ? day && week : day || week),
    }
  }
  return { local, fields }
}

export function parseSchedule(input: string | Schedule, now = Date.now()): Schedule {
  let schedule: Schedule
  if (typeof input !== 'string') schedule = { ...input }
  else if (input.startsWith('in '))
    schedule = { kind: 'at', time: new Date(now + duration(input.slice(3).trim())).toISOString() }
  else if (input.startsWith('every '))
    schedule = { kind: 'every', ms: duration(input.slice(6).trim()) }
  else if (input.startsWith('cron ')) {
    const match = /^cron\s+"([^"]+)"(?:\s+(\S+))?$/.exec(input)
    if (!match) throw new Error('Use cron "0 9 * * 1-5" Europe/Vienna')
    schedule = {
      kind: 'cron',
      expr: match[1],
      tz: match[2] ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    }
  } else schedule = { kind: 'at', time: input.replace(/^at\s+/, '') }
  if (schedule.kind === 'every') {
    if (!Number.isFinite(schedule.ms) || schedule.ms < 1000)
      throw new Error('Intervals must be at least 1s')
  } else if (schedule.kind === 'at') {
    if (!/^\d{4}-\d\d-\d\dT/.test(schedule.time) || !Number.isFinite(Date.parse(schedule.time)))
      throw new Error('Use an ISO time')
    schedule.time = new Date(schedule.time).toISOString()
  } else {
    schedule.tz ||= Intl.DateTimeFormat().resolvedOptions().timeZone
    cron(schedule.expr, schedule.tz)
  }
  return schedule
}

/**
 * The next fire after `after`. Cron follows cron's rules: a restricted day of month and weekday match either (OR), a
 * local minute that the spring daylight-saving gap skips never fires (it is not shifted), and a wall-clock minute that
 * the autumn hour repeats fires once (`previous`'s wall time). The search stops at eight years, which covers leap-day
 * schedules.
 */
export function nextAt(schedule: Schedule, after: number, previous = after): number {
  if (schedule.kind === 'at') return Date.parse(schedule.time)
  if (schedule.kind === 'every') return after + schedule.ms
  const { local, fields } = cron(schedule.expr, schedule.tz)
  const previousWall = local(previous).wall
  const start = Math.floor(after / 60000) * 60000 + 60000
  let time = start
  while (time <= start + 8 * 366 * 86400000) {
    const p = local(time)
    if (!p.dateMatches) {
      const minutes = 1440 - p.hour * 60 - p.minute
      const target = p.wall + minutes * 60000
      const candidate = time + minutes * 60000
      // Correct the midnight jump for an offset change, without crossing a matching day.
      time = Math.max(time + 60000, candidate + target - local(candidate).wall)
    } else if (!fields[1].has(p.hour)) {
      time += (60 - p.minute) * 60000
    } else if (fields[0].has(p.minute) && p.wall !== previousWall) return time
    else time += 60000
  }
  throw new Error('Cron has no fire within 8 years')
}

export function describeSchedule(schedule: Schedule): string {
  if (schedule.kind === 'at') return `Once at ${schedule.time}`
  if (schedule.kind === 'cron') {
    const [minute, hour, day, month, weekday] = schedule.expr.trim().split(/\s+/)
    const clock =
      /^\d+$/.test(minute) && /^\d+$/.test(hour)
        ? `At ${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`
        : minute === '*' && hour === '*'
          ? 'Every minute'
          : `At minutes ${minute} of hours ${hour}`
    const days =
      weekday === '1-5'
        ? ' on weekdays'
        : weekday === '*'
          ? ''
          : ` on weekdays ${weekday} (Sunday=0)`
    const dates = day === '*' ? '' : ` on month days ${day}`
    const months = month === '*' ? '' : ` in months ${month}`
    return `${clock}${dates}${dates && days ? ' or' : ''}${days}${months} (${schedule.tz})`
  }
  for (const [unit, ms] of [
    ['day', 86400000],
    ['hour', 3600000],
    ['minute', 60000],
    ['second', 1000],
  ] as const)
    if (schedule.ms % ms === 0) {
      const n = schedule.ms / ms
      return `Every ${n} ${unit}${n === 1 ? '' : 's'}`
    }
  return `Every ${schedule.ms / 1000} seconds`
}
