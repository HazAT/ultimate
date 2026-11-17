import { parseEntryId } from '../../lib/ids.ts'
import { implementAction } from '../../lib/actions.ts'
import { defineEvent } from '../../shared/events.ts'
import { PageAction } from './refs.ts'

export default { name: 'activity' }

const LIMIT = 200

export const pollActions = ['page']
export const actions = {
  page: implementAction(PageAction, async (args, { host }) => {
    const { kinds, before, since, limit = 50 } = (args ?? {}) as Record<string, unknown>
    if (!Array.isArray(kinds) || !kinds.length || !kinds.every((kind) => typeof kind === 'string'))
      throw new Error('kinds must name at least one event')
    if (before !== undefined && !Number.isSafeInteger(before))
      throw new Error('before must be an event id')
    if (since !== undefined && (typeof since !== 'string' || Number.isNaN(Date.parse(since))))
      throw new Error('since must be an ISO time')
    if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > LIMIT)
      throw new Error(`limit must be an integer from 1 to ${LIMIT}`)
    const eventsPlusPaginationProbe = await host.eventLog.recent({
      events: kinds.map((kind) => defineEvent(kind)),
      ...(before === undefined ? {} : { before: parseEntryId(Number(before)) }),
      limit: (limit as number) + 1,
    })
    const floor = since === undefined ? -Infinity : Date.parse(since)
    const recent = eventsPlusPaginationProbe.filter((event) => Date.parse(event.at) >= floor)
    const events = recent.slice(0, limit as number)
    const more = recent.length > events.length
    return { events, ...(more ? { next: events.at(-1)!.id } : {}) }
  }),
}
