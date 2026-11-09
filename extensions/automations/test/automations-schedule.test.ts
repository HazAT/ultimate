import { describe, expect, it } from 'vitest'
import { describeSchedule, nextAt, parseSchedule } from '../schedule.ts'

const time = Date.parse('2026-01-05T08:00:00Z')
const next = (expr: string, tz = 'UTC') =>
  new Date(nextAt(parseSchedule(`cron "${expr}" ${tz}`), time)).toISOString()
describe('automation schedules', () => {
  it('matches fields, lists, ranges, steps, Sunday 7 and timezones', () => {
    expect(next('30 9 5 1 *')).toBe('2026-01-05T09:30:00.000Z')
    expect(next('5,10 8-10 * * 1-5')).toBe('2026-01-05T08:05:00.000Z')
    expect(next('*/15 * * * *')).toBe('2026-01-05T08:15:00.000Z')
    expect(next('10-30/10 * * * *')).toBe('2026-01-05T08:10:00.000Z')
    expect(next('0 9 * * 7')).toBe('2026-01-11T09:00:00.000Z')
    expect(next('0 10 * * 1-5', 'Europe/Vienna')).toBe('2026-01-05T09:00:00.000Z')
    expect(next('0 8 * * *')).toBe('2026-01-06T08:00:00.000Z')
    expect(next('0 9 10 * 1')).toBe('2026-01-05T09:00:00.000Z')
    expect(next('0 9 */2 * *')).toBe('2026-01-05T09:00:00.000Z')
    expect(next('0 9 */3 * *')).toBe('2026-01-07T09:00:00.000Z')
  })
  it('jumps sparse dates, rejects impossible ones and finds leap days', () => {
    const yearly = parseSchedule('cron "0 0 1 1 *" Europe/Vienna')
    const impossible = parseSchedule('cron "0 0 31 4 *" Europe/Vienna')
    expect(new Date(nextAt(yearly, time)).toISOString()).toBe('2026-12-31T23:00:00.000Z')
    expect(() => nextAt(impossible, time)).toThrow('8 years')
    expect(nextAt(parseSchedule('cron "0 0 29 2 *" UTC'), time)).toBe(
      Date.parse('2028-02-29T00:00:00Z'),
    )
  })
  it('fires once in the repeated hour and skips nonexistent spring minutes', () => {
    const schedule = parseSchedule('cron "30 2 * * *" Europe/Vienna')
    const first = nextAt(schedule, Date.parse('2026-10-24T23:00:00Z'))
    expect(first).toBe(Date.parse('2026-10-25T00:30:00Z'))
    expect(nextAt(schedule, first)).toBe(Date.parse('2026-10-26T01:30:00Z'))
    expect(nextAt(schedule, Date.parse('2026-03-28T23:00:00Z'))).toBe(
      Date.parse('2026-03-30T00:30:00Z'),
    )
  })
  it('parses relative, at and interval schedules and describes them', () => {
    expect(parseSchedule('in 30m', time)).toEqual({ kind: 'at', time: '2026-01-05T08:30:00.000Z' })
    expect(parseSchedule('in 2h', time)).toEqual({ kind: 'at', time: '2026-01-05T10:00:00.000Z' })
    expect(parseSchedule('in 1d', time)).toEqual({ kind: 'at', time: '2026-01-06T08:00:00.000Z' })
    expect(nextAt(parseSchedule('every 2s'), time)).toBe(time + 2000)
    expect(describeSchedule(parseSchedule('every 15m'))).toBe('Every 15 minutes')
    expect(describeSchedule(parseSchedule('every 1h'))).toBe('Every 1 hour')
    expect(describeSchedule(parseSchedule('in 30m', time))).toContain('Once at')
    expect(describeSchedule(parseSchedule('cron "0 9 * * 1-5" Europe/Vienna'))).toContain(
      'Europe/Vienna',
    )
    expect(parseSchedule('cron "* * * * *"').kind).toBe('cron')
  })
  it('rejects invalid input and impossible cron dates', () => {
    for (const input of [
      'every 0.5s',
      'every nope',
      'in nope',
      'at nope',
      'cron "60 * * * *"',
      'cron "*/0 * * * *"',
      'cron "0 9 * *"',
      'cron "* * * * *" Mars',
      'cron "0 9 * * 5-1"',
    ])
      expect(() => parseSchedule(input)).toThrow(/.+/)
    expect(() => nextAt(parseSchedule('cron "0 9 31 2 *" UTC'), time)).toThrow('8 years')
  })
})
