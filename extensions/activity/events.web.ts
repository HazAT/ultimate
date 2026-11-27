import { defineEvent, NoticeEvent } from '../../shared/events.ts'
import type { EventData, EventRecord } from '../../shared/events.ts'
import type { Escalated } from '../automations/refs.ts'
import type { BackupEvent } from '../cloud/refs.ts'
import type { Branched, Rooted } from '../lineage/refs.ts'
import type { CheckRan, SubmissionLanded } from '../workspaces/refs.ts'

export const Backup = defineEvent<EventData<typeof BackupEvent>>('cloud.backup')
export const Escalation = defineEvent<EventData<typeof Escalated>>('automations.escalated')

export function activityRules(tokens: {
  landed: typeof SubmissionLanded
  branched: typeof Branched
  rooted: typeof Rooted
  check: typeof CheckRan
}) {
  const branches = [tokens.branched, tokens.rooted] as const
  const problems = [NoticeEvent, tokens.check, Backup, Escalation] as const
  const filters = {
    all: [tokens.landed, ...branches, ...problems],
    landed: [tokens.landed],
    branches,
    problems,
  } as const

  function tone(event: EventRecord): 'error' | 'warning' | 'quiet' | undefined {
    if (NoticeEvent.is(event)) {
      const { level } = event.data
      return level === 'error' || level === 'warning' ? level : undefined
    }
    if (tokens.check.is(event))
      return event.data.result === 'passed'
        ? 'quiet'
        : event.data.result === 'flaky'
          ? 'warning'
          : 'error'
    if (Backup.is(event))
      return event.data.phase === 'failed'
        ? 'error'
        : event.data.phase === 'started'
          ? 'quiet'
          : undefined
    if (Escalation.is(event)) return 'error'
    return undefined
  }

  function shows(filter: Filter, event: EventRecord) {
    if (!filters[filter].some((token) => token.is(event))) return false
    const color = tone(event)
    return filter === 'problems' ? color === 'error' || color === 'warning' : color !== 'quiet'
  }

  return { filters, shows, tone }
}

export type Filter = keyof ReturnType<typeof activityRules>['filters']

export const joined = (lists: readonly (readonly EventRecord[])[]) =>
  [...new Map(lists.flat().map((event) => [event.id, event])).values()].toSorted(
    (a, b) => b.id - a.id,
  )
