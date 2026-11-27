import type { ConversationId } from '@earendil-works/pi-durable'
import { CircleX, Cloud, GitFork, GitMerge, ScrollText, TriangleAlert } from '@lucide/solid'
import type { JSX } from '@solidjs/web'
import { For, Show, createMemo } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { cn, events, formatAgo, showSurface, switchConversation } from '@/sdk/solid'
import { compareUrl } from '../../lib/compare.shared.ts'
import { NoticeEvent } from '../../shared/events.ts'
import type { EventData, EventRecord } from '../../shared/events.ts'
import { ConversationRef, FeatureTag } from '../conversations/ui.solid.tsx'
import { Branched, Rooted } from '../lineage/refs.ts'
import { CheckRan, SubmissionLanded } from '../workspaces/refs.ts'
import { CommitCount, useGithubRepo } from '../workspaces/ui.solid.tsx'
import { BackupEvent } from '../cloud/refs.ts'
import { Escalated } from '../automations/refs.ts'
import { activityRules } from './events.web.ts'

export const { filters, shows, tone } = activityRules({
  landed: SubmissionLanded,
  branched: Branched,
  rooted: Rooted,
  check: CheckRan,
})

type Target = { conversation: ConversationId; entry?: number }
const inConversation = (event: EventRecord): Target | undefined => {
  const conversation = event.context?.conversationId
  return conversation === undefined ? undefined : { conversation }
}

function Row(props: {
  event: EventRecord
  icon: JSX.Element
  target?: Target
  title: string
  trailing?: JSX.Element
  now: number
  children: JSX.Element
}) {
  const at = () => Date.parse(props.event.at)
  const body = () => (
    <>
      {props.icon}
      <span class="flex min-w-0 flex-1 items-center gap-1.5">{props.children}</span>
    </>
  )
  const layout = 'flex min-w-0 flex-1 items-start gap-2'
  return (
    <li
      class="flex min-w-0 items-start gap-1.5 border-l-2 border-transparent py-[3px] pr-3 pl-2.5 font-mono text-[10.5px] leading-[18px] text-muted-foreground hover:bg-muted/40 pointer-coarse:py-1.5 data-[tone=error]:border-error/70 data-[tone=error]:bg-error/[0.06] data-[tone=warning]:border-warning/60 data-[tone=warning]:bg-warning/[0.04]"
      data-activity={props.event.name}
      data-tone={tone(props.event)}
    >
      <Show
        when={props.target}
        fallback={
          <span class={layout} title={props.title}>
            {body()}
          </span>
        }
      >
        {(target) => {
          const destination = () =>
            `#${target().conversation}${target().entry === undefined ? '' : `/${target().entry}`}`
          return (
            <Button
              aria-label={`Open activity event ${props.event.id}: ${props.title} · ${destination()}`}
              class={`${layout} justify-start rounded-none text-left text-[10.5px] font-normal whitespace-normal focus-visible:ring-1 focus-visible:ring-ring`}
              onClick={() => {
                const { conversation, entry } = target()
                if (entry !== undefined) events.emit('messages:open', { conversation, entry })
                showSurface('agent')
                switchConversation(conversation)
              }}
              size={null}
              title={`${props.title} · open ${destination()}`}
              variant={null}
            >
              {body()}
            </Button>
          )
        }}
      </Show>
      {props.trailing}
      <time
        class="w-7 shrink-0 text-right text-muted-foreground/60 tabular-nums"
        datetime={props.event.at}
        title={new Date(at()).toLocaleString()}
      >
        {formatAgo(at(), props.now)}
      </time>
    </li>
  )
}

const icon = 'mt-[3px] size-3 shrink-0'
const name = 'min-w-0 truncate font-sans text-[12px] text-foreground/85'
const refClass = 'font-sans text-[12px] text-foreground/85'
type RowProps<T> = { event: EventRecord<EventData<T>>; now: number }

function Landing(props: RowProps<typeof SubmissionLanded>) {
  const github = useGithubRepo()
  const data = () => props.event.data
  const sha = () => data().sha.slice(0, 7)
  const href = () => {
    const repo = github()
    return repo ? compareUrl(repo, data().base, data().sha) : undefined
  }
  return (
    <Row
      event={props.event}
      icon={<GitMerge class={`${icon} text-success`} />}
      now={props.now}
      target={{ conversation: data().conversationId, entry: data().at }}
      title={`Landed ${sha()} on ${data().target}${data().title ? ` · ${data().title}` : ''}`}
      trailing={
        <CommitCount
          class="text-muted-foreground/80"
          count={data().commitCount}
          href={href()}
          range={`${data().base}...${data().sha}`}
        />
      }
    >
      <Show when={data().feature}>
        {(feature) => <FeatureTag class="shrink-0" feature={feature()} />}
      </Show>
      <span class={name}>{data().title || sha()}</span>
    </Row>
  )
}

function Brief(props: { label: string; tone?: string; children: JSX.Element }) {
  return (
    <span class="line-clamp-2 min-w-0 font-sans text-[12px] break-words text-foreground/80">
      <span
        class="mr-1.5 font-mono text-[10.5px] data-[tone=error]:text-error data-[tone=warning]:text-warning"
        data-tone={props.tone}
      >
        {props.label}
      </span>
      {props.children}
    </span>
  )
}

function Activity(props: { event: EventRecord; now: number }) {
  const row = createMemo(() => {
    const event = props.event
    if (SubmissionLanded.is(event)) return <Landing event={event} now={props.now} />
    if (Branched.is(event)) {
      const { id, from } = event.data
      return (
        <Row
          event={event}
          icon={<GitFork class={`${icon} text-brand`} />}
          now={props.now}
          target={{ conversation: id }}
          title={`Branched from #${from}`}
        >
          <ConversationRef class={refClass} id={id} />
          <span class="shrink-0">from #{from}</span>
        </Row>
      )
    }
    if (Rooted.is(event)) {
      const { id, intent } = event.data
      return (
        <Row
          event={event}
          icon={<ScrollText class={`${icon} text-brand`} />}
          now={props.now}
          target={{ conversation: id }}
          title={`New root: ${intent}`}
        >
          <span class="shrink-0">new root</span>
          <ConversationRef class={refClass} id={id} title={intent} />
        </Row>
      )
    }
    if (NoticeEvent.is(event)) {
      const { extension, level, message } = event.data
      const warning = level === 'warning'
      return (
        <Row
          event={event}
          icon={<TriangleAlert class={cn(icon, warning && 'text-warning')} />}
          now={props.now}
          target={inConversation(event)}
          title={`${extension}: ${message}`}
        >
          <Brief label={extension} tone={warning ? level : undefined}>
            {message}
          </Brief>
        </Row>
      )
    }
    if (CheckRan.is(event)) {
      const { command, result, ms } = event.data
      const flaky = result === 'flaky'
      return (
        <Row
          event={event}
          icon={
            flaky ? (
              <TriangleAlert class={`${icon} text-warning`} />
            ) : (
              <CircleX class={`${icon} text-error`} />
            )
          }
          now={props.now}
          target={inConversation(event)}
          title={`Lander check ${result} after ${Math.round(ms / 1000)}s: ${command}`}
        >
          <span class={cn('shrink-0', flaky ? 'text-warning' : 'text-error')}>check {result}</span>
          <code class={cn(name, 'font-mono text-[11px]')}>{command}</code>
        </Row>
      )
    }
    if (BackupEvent.is(event)) {
      const data = event.data
      const failure = data.phase === 'failed' ? (data.error ?? data.reason) : undefined
      return (
        <Row
          event={event}
          icon={<Cloud class={cn(icon, failure !== undefined && 'text-error')} />}
          now={props.now}
          title={failure === undefined ? 'Backed up to the cloud' : `Backup failed: ${failure}`}
        >
          {failure !== undefined ? (
            <Brief label="backup failed" tone="error">
              {failure}
            </Brief>
          ) : (
            <span class={name}>Backed up</span>
          )}
        </Row>
      )
    }
    if (Escalated.is(event)) {
      const { id, reason } = event.data
      return (
        <Row
          event={event}
          icon={<CircleX class={`${icon} text-error`} />}
          now={props.now}
          title={`Automation ${id} escalated: ${reason}`}
        >
          <Brief label={`${id} escalated`} tone="error">
            {reason}
          </Brief>
        </Row>
      )
    }
    return null
  })
  return <>{row()}</>
}

export function Feed(props: { events: readonly EventRecord[]; now: number; empty: string }) {
  return (
    <Show
      when={props.events.length > 0}
      fallback={
        <div class="px-3 py-6 text-center font-mono text-[11.5px] text-muted-foreground/70">
          {props.empty}
        </div>
      }
    >
      <ul class="flex flex-col">
        <For each={props.events} keyed={(event) => event.id}>
          {(event) => <Activity event={event()} now={props.now} />}
        </For>
      </ul>
    </Show>
  )
}
