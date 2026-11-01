import {
  CircleXIcon,
  CloudIcon,
  GitForkIcon,
  GitMergeIcon,
  ScrollTextIcon,
  TriangleAlertIcon,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { cn, events, formatAgo, useUltimate } from '@/sdk'
import type { EventData, EventRecord } from '@/sdk'
import { compareUrl } from '../../lib/compare.ts'
import { defineEvent, NoticeEvent } from '../../shared/events.ts'
import type { BackupEvent as BackupToken } from '../cloud/refs.ts'
import type { Escalated as EscalatedToken } from '../automations/refs.ts'
import { ConversationRef, FeatureTag } from '../conversations/ui.tsx'
import { Branched, Rooted } from '../lineage/ui.tsx'
import { CheckRan, CommitCount, SubmissionLanded, useGithubRepo } from '../workspaces/ui.tsx'

// Optional extensions' events, by name: their browser contracts are not imported, so Activity loads without them.
const Backup = defineEvent<EventData<typeof BackupToken>>('cloud.backup')
const Escalated = defineEvent<EventData<typeof EscalatedToken>>('automations.escalated')

/** The events the feed shows, each with its own row. */
export const activityEvents = [
  SubmissionLanded,
  Branched,
  Rooted,
  NoticeEvent,
  CheckRan,
  Backup,
  Escalated,
] as const
export type ActivityEvent = EventRecord<EventData<(typeof activityEvents)[number]>>

/** The feed's kind filters, each the events it keeps. */
export const filters = {
  all: activityEvents,
  landed: [SubmissionLanded],
  branches: [Branched, Rooted],
  problems: [NoticeEvent, CheckRan, Backup, Escalated],
} as const
export type Filter = keyof typeof filters

/** How loud an event is: `error` and `warning` stand out in the feed; `quiet` ones show only under Problems. */
export function tone(event: EventRecord): 'error' | 'warning' | 'quiet' | undefined {
  if (NoticeEvent.is(event))
    return event.data.level === 'error'
      ? 'error'
      : event.data.level === 'warning'
        ? 'warning'
        : undefined
  if (CheckRan.is(event))
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
  if (Escalated.is(event)) return 'error'
  return undefined
}

/**
 * Whether filter `filter` shows `event`: Problems only warnings and errors; passed checks and started backups are noise
 * and never show.
 */
export function shows(filter: Filter, event: EventRecord) {
  if (!filters[filter].some((token) => token.is(event))) return false
  const loudness = tone(event)
  return filter === 'problems'
    ? loudness === 'error' || loudness === 'warning'
    : loudness !== 'quiet'
}

/** Lists of events as one, newest first, each event once. */
export const joined = (lists: readonly (readonly ActivityEvent[])[]) =>
  [...new Map(lists.flat().map((event) => [event.id, event])).values()].toSorted(
    (a, b) => b.id - a.id,
  )

/** Where a row leads: a conversation, at an entry when there is one. */
type Target = { conversation: number; entry?: number }

/** Opens `target` on the Agent surface, revealing its entry, as the root row's landings do. */
function useOpen() {
  const actions = useUltimate()
  return ({ conversation, entry }: Target) => {
    if (entry !== undefined) events.emit('messages:open', { conversation, entry })
    actions.showSurface('agent')
    actions.switchConversation(conversation)
  }
}

/** One event as one quiet line: an icon for its kind, what happened, a link where there is one, and its age. */
function Row({
  event,
  icon,
  target,
  title,
  trailing,
  now,
  children,
}: {
  event: EventRecord
  icon: ReactNode
  target?: Target
  title: string
  trailing?: ReactNode
  now: number
  children: ReactNode
}) {
  const open = useOpen()
  const at = Date.parse(event.at)
  const body = (
    <>
      {icon}
      <span className="flex min-w-0 flex-1 items-center gap-1.5">{children}</span>
    </>
  )
  const loud = tone(event)
  return (
    <li
      className={cn(
        'flex min-w-0 items-start gap-1.5 border-l-2 border-transparent py-[3px] pr-3 pl-2.5 font-mono pointer-coarse:py-1.5 text-[10.5px] leading-[18px] text-muted-foreground hover:bg-muted/40',
        loud === 'error' && 'border-error/70 bg-error/[0.06]',
        loud === 'warning' && 'border-warning/60 bg-warning/[0.04]',
      )}
      data-activity={event.name}
      data-tone={loud}
    >
      {target ? (
        <button
          className="flex min-w-0 flex-1 cursor-pointer items-start gap-2 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onClick={() => open(target)}
          title={`${title} · open #${target.conversation}${target.entry !== undefined ? `/${target.entry}` : ''}`}
          type="button"
        >
          {body}
        </button>
      ) : (
        <span className="flex min-w-0 flex-1 items-start gap-2" title={title}>
          {body}
        </span>
      )}
      {trailing}
      <time
        className="w-7 shrink-0 text-right text-muted-foreground tabular-nums"
        dateTime={event.at}
        title={new Date(at).toLocaleString()}
      >
        {formatAgo(at, now)}
      </time>
    </li>
  )
}

const iconClass = 'mt-[3px] size-3 shrink-0'
const name = 'min-w-0 truncate font-sans text-[12px] text-foreground/85'

type Props<T> = { event: EventRecord<EventData<T>>; now: number }

function Landing({ event, now }: Props<typeof SubmissionLanded>) {
  const github = useGithubRepo()
  const landing = event.data
  return (
    <Row
      event={event}
      icon={<GitMergeIcon className={cn(iconClass, 'text-success')} />}
      now={now}
      target={{ conversation: landing.conversationId, entry: landing.at }}
      title={`Landed ${landing.sha.slice(0, 7)} on ${landing.target}${landing.title ? ` · ${landing.title}` : ''}`}
      trailing={
        <CommitCount
          className="text-muted-foreground"
          count={landing.commitCount}
          href={github ? compareUrl(github, landing.base, landing.sha) : undefined}
          range={`${landing.base}...${landing.sha}`}
        />
      }
    >
      {landing.feature && <FeatureTag className="shrink-0" feature={landing.feature} />}
      <span className={name}>{landing.title || landing.sha.slice(0, 7)}</span>
    </Row>
  )
}

function Branch({ event, now }: Props<typeof Branched>) {
  const { id, from } = event.data
  return (
    <Row
      event={event}
      icon={<GitForkIcon className={cn(iconClass, 'text-brand')} />}
      now={now}
      target={{ conversation: id }}
      title={`Branched from #${from}`}
    >
      <ConversationRef className="font-sans text-[12px] text-foreground/85" id={id} />
      <span className="shrink-0">from #{from}</span>
    </Row>
  )
}

function Root({ event, now }: Props<typeof Rooted>) {
  const { id, intent } = event.data
  return (
    <Row
      event={event}
      icon={<ScrollTextIcon className={cn(iconClass, 'text-brand')} />}
      now={now}
      target={{ conversation: id }}
      title={`New root: ${intent}`}
    >
      <span className="shrink-0">new root</span>
      <ConversationRef
        className="font-sans text-[12px] text-foreground/85"
        id={id}
        title={intent}
      />
    </Row>
  )
}

function Notice({ event, now }: Props<typeof NoticeEvent>) {
  const { extension, message, level } = event.data
  const warning = level === 'warning'
  const conversation = event.context?.conversationId
  return (
    <Row
      event={event}
      icon={
        <TriangleAlertIcon
          className={cn(iconClass, warning ? 'text-warning' : 'text-muted-foreground')}
        />
      }
      now={now}
      target={conversation === undefined ? undefined : { conversation }}
      title={`${extension}: ${message}`}
    >
      <span className="line-clamp-2 min-w-0 font-sans text-[12px] break-words text-foreground/80">
        <span className={cn('mr-1.5 font-mono text-[10.5px]', warning && 'text-warning')}>
          {extension}
        </span>
        {message}
      </span>
    </Row>
  )
}

function Check({ event, now }: Props<typeof CheckRan>) {
  const { command, result, ms } = event.data
  const conversation = event.context?.conversationId
  const error = result !== 'flaky'
  return (
    <Row
      event={event}
      icon={
        error ? (
          <CircleXIcon className={cn(iconClass, 'text-error')} />
        ) : (
          <TriangleAlertIcon className={cn(iconClass, 'text-warning')} />
        )
      }
      now={now}
      target={conversation === undefined ? undefined : { conversation }}
      title={`Lander check ${result} after ${Math.round(ms / 1000)}s: ${command}`}
    >
      <span className={cn('shrink-0', error ? 'text-error' : 'text-warning')}>check {result}</span>
      <code className={cn(name, 'font-mono text-[11px]')}>{command}</code>
    </Row>
  )
}

function CloudBackup({ event, now }: Props<typeof Backup>) {
  const data = event.data
  const failed = data.phase === 'failed'
  return (
    <Row
      event={event}
      icon={
        <CloudIcon className={cn(iconClass, failed ? 'text-error' : 'text-muted-foreground')} />
      }
      now={now}
      title={failed ? `Backup failed: ${data.error ?? data.reason}` : 'Backed up to the cloud'}
    >
      {failed ? (
        <span className="line-clamp-2 min-w-0 font-sans text-[12px] break-words text-foreground/80">
          <span className="mr-1.5 font-mono text-[10.5px] text-error">backup failed</span>
          {data.error ?? data.reason}
        </span>
      ) : (
        <span className={name}>Backed up</span>
      )}
    </Row>
  )
}

function Escalation({ event, now }: Props<typeof Escalated>) {
  const { id, reason } = event.data
  return (
    <Row
      event={event}
      icon={<CircleXIcon className={cn(iconClass, 'text-error')} />}
      now={now}
      title={`Automation ${id} escalated: ${reason}`}
    >
      <span className="line-clamp-2 min-w-0 font-sans text-[12px] break-words text-foreground/80">
        <span className="mr-1.5 font-mono text-[10.5px] text-error">{id} escalated</span>
        {reason}
      </span>
    </Row>
  )
}

function Activity({ event, now }: { event: ActivityEvent; now: number }) {
  if (SubmissionLanded.is(event)) return <Landing event={event} now={now} />
  if (Branched.is(event)) return <Branch event={event} now={now} />
  if (Rooted.is(event)) return <Root event={event} now={now} />
  if (NoticeEvent.is(event)) return <Notice event={event} now={now} />
  if (CheckRan.is(event)) return <Check event={event} now={now} />
  if (Backup.is(event)) return <CloudBackup event={event} now={now} />
  if (Escalated.is(event)) return <Escalation event={event} now={now} />
  return null
}

/** Events newest first, one line each; `empty` says why there are none. */
export function Feed({
  events: list,
  now,
  empty = 'quiet · nothing has happened yet',
}: {
  events: readonly ActivityEvent[]
  now: number
  empty?: string
}) {
  if (list.length === 0)
    return (
      <div className="px-3 py-6 text-center font-mono text-[11.5px] text-muted-foreground">
        {empty}
      </div>
    )
  return (
    <ul className="flex flex-col">
      {list.map((event) => (
        <Activity event={event} key={event.id} now={now} />
      ))}
    </ul>
  )
}
