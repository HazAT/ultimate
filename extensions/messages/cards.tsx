import type { EntryRecord } from '@earendil-works/pi-durable'
import {
  ArrowLeftRightIcon,
  CheckIcon,
  CornerDownRightIcon,
  CornerLeftUpIcon,
  GlobeIcon,
  ChevronRightIcon,
  GitBranchIcon,
  InboxIcon,
  MailIcon,
  SendIcon,
  SquareArrowOutUpRightIcon,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { MessageResponse } from '@/components/ai/message'
import { Shimmer } from '@/components/ai/shimmer'
import { ToolImage } from '@/components/ai/tool'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  api,
  Card,
  cn,
  events,
  Fold,
  formatAgo,
  MessageActions,
  Provided,
  useCompact,
  useConversation,
  useConversations,
  useDocOf,
  useNow,
  useTranscript,
  useUltimate,
  UserText,
  UserView,
} from '@/sdk'
import type { CompactSummaryProps, ToolCallView } from '@/sdk'
import { AgentMark, agentTitle, ConversationRef } from '../conversations/ui.tsx'
import { openAgentSource, StandingDoc } from '../subagents/ui.tsx'
import { useWorkspaceIndex } from '../workspaces/ui.tsx'
import { accentOf } from './accent.tsx'
import {
  answerTo,
  answeredMessages,
  callFailed,
  backgroundRow,
  counterparts,
  emptyMessages,
  landed,
  landedSha,
  messageStatus,
  outgoingState,
  remoteLabel,
  sentBy,
  sentStatus,
} from './data.tsx'
import { imagesOf } from '../../lib/entries.ts'
import { callerOf } from './caller.ts'
import { MessagesDoc } from './refs.ts'
import type { Message, Remote } from './refs.ts'
import { MessageAnswers } from './points.tsx'

/** What an optional extension shows under a message to the user: questions' answer card. */
const Answers = ({ message }: { message: Message }) => (
  <Provided input={message} point={MessageAnswers}>
    {(answers) => answers}
  </Provided>
)

/** The accent of sender `id`: @ultimate's fixed one when the standing agents name it, else `accentOf`. */
export function useAccentOf(id: number | 'user' | 'remote') {
  const standing = useDocOf(1, StandingDoc)
  return accentOf(standing?.ultimate === id ? 'ultimate' : id)
}

/**
 * Who `id` is: you, another project's Ultimate (`remote` names it), `@name` for a standing agent or the lander (with its
 * mark when `mark`), else a conversation link. The ULTIMATE wordmark takes the colour of its surroundings: the accent
 * of the bubble it heads.
 */
export function Address({
  id,
  mark = false,
  remote,
}: {
  id: number | 'user' | 'remote'
  mark?: boolean
  remote?: Pick<Remote, 'project' | 'machine'>
}) {
  const standing = useDocOf(1, StandingDoc)
  const workspaces = useWorkspaceIndex()
  if (id === 'user') return <span>you</span>
  if (id === 'remote')
    return (
      <span className="flex min-w-0 items-center gap-1.5" title="Another project's Ultimate">
        {mark && <GlobeIcon className="size-3.5 shrink-0" />}
        <span className="truncate">{remote ? remoteLabel(remote) : 'another Ultimate'}</span>
      </span>
    )
  const name =
    Object.entries(standing ?? {}).find(([, value]) => value === id)?.[0] ??
    (Object.values(workspaces.landerConversations).includes(id) ? 'lander' : undefined)
  if (!name) return <ConversationRef id={id} />
  if (mark && name === 'ultimate')
    return (
      <span className="flex items-center gap-1.5" title="@ultimate">
        <AgentMark name={name} size="sm" />
        <span className="font-sans text-[10.5px] font-semibold tracking-[0.28em]">ULTIMATE</span>
      </span>
    )
  return (
    <span className="flex items-center gap-1.5">
      {mark && <AgentMark name={name} size="sm" />}@{name}
    </span>
  )
}

/** A message's text; `pending` shimmers in its place until the model has written any, on the line the text takes. */
export function Body({ text, pending }: { text: string; pending?: string }) {
  return (
    <div className="min-w-0 px-3 py-3 text-[13px] leading-relaxed">
      {pending && !text ? (
        <Shimmer as="p">{pending}</Shimmer>
      ) : (
        <MessageResponse>{text}</MessageResponse>
      )}
    </div>
  )
}

/** Who waits on whom, in words: an open question to the user stands out, other open requests stay amber-muted. */
function Status({ message, perspective }: { message: Message; perspective: number | 'user' }) {
  const status = messageStatus(message)
  if (status === 'yours')
    return (
      <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-700 dark:text-amber-300">
        awaiting your reply
      </span>
    )
  if (status === 'waiting')
    return (
      <span className="flex min-w-0 flex-wrap items-center gap-1 text-amber-700/80 dark:text-amber-300/70">
        {message.from !== perspective && <Address id={message.from} remote={message.remote} />}
        waiting on <Address id={message.to} remote={message.remote} />
      </span>
    )
  if (status === 'answered')
    return (
      <span className="flex items-center gap-1">
        <CheckIcon className="size-3" />
        answered
      </span>
    )
  return <span className={status === 'failed' ? 'text-destructive' : ''}>{status}</span>
}

/**
 * A message to you in compact mode: a bubble on the left in the sender's accent, its text, and whether it waits on you.
 * `children` mount beneath the text; that is where the answer card of a question goes. `lead` mounts above it: what the
 * message answers. Without `text`, `children` alone are its body (a reply still being worked on). `running` is whether
 * the call that sends it is still running. With `entry`, the stored answer or the response that sent the message, its footer
 * carries the transcript's message actions: usage, time, copy, go back and a reference link.
 */
export function Bubble({
  from,
  message,
  text,
  running,
  entry,
  at = message?.at,
  lead,
  children,
}: {
  from: number
  message: Message | undefined
  text?: string
  running: boolean
  entry?: EntryRecord
  /** When it was said; a message's own time by default. */
  at?: number
  lead?: ReactNode
  children?: ReactNode
}) {
  const now = useNow(60000)
  const log = useDocOf(1, MessagesDoc)
  const accent = useAccentOf(from)
  const status = sentStatus(message, running)
  const stored = entry?.model?.[0]
  const answer = message && log ? answerTo(log.messages, message) : undefined
  // While the model still writes it, the body says so; a `sending` footer would repeat it.
  const writing = running && !message && !text
  // In compact mode, how a message was sent is no news: only what asks something of you, or went wrong, says so.
  const shown =
    status === 'yours' ||
    (status === 'sending' && !writing) ||
    status === 'failed' ||
    status === 'stopped' ||
    status === 'dismissed'
  // Prose on the page under a name line; what mounts beneath the text shares one quiet card.
  return (
    <section
      data-message-outgoing={message?.id}
      data-compact-bubble
      className="group/bubble mt-2 w-full min-w-0"
    >
      <header className="flex h-6 min-w-0 items-center gap-2 font-mono text-[11px] text-muted-foreground">
        <Sender id={from} tone={accent.name} />
        {entry ? (
          // One line: on a narrow column the details clip on the left instead of wrapping into an empty second row.
          <MessageActions
            bubble
            className="ml-auto min-w-0 flex-nowrap justify-end overflow-hidden whitespace-nowrap"
            entry={entry}
            text={text ?? ''}
            timestamp={at ?? (stored && 'timestamp' in stored ? stored.timestamp : 0)}
          />
        ) : (
          at !== undefined && (
            <time
              className="ml-auto shrink-0"
              dateTime={new Date(at).toISOString()}
              title={new Date(at).toLocaleString()}
            >
              {formatAgo(at, now)}
            </time>
          )
        )}
      </header>
      <div className="[&>div]:px-0 [&>div]:pt-1.5 [&>div]:pb-0">
        {lead}
        {text !== undefined && (
          <Body pending={writing ? 'Writing you a message…' : undefined} text={text} />
        )}
      </div>
      <div className="mt-3 overflow-hidden rounded-lg border border-border/70 bg-card/60 empty:hidden [&>:first-child]:border-t-0">
        {message?.images && <MessageImages conversation={from} entry={message.images.entry} />}
        {children}
        {answer && <AttachedAnswer answer={answer} question={message!} />}
        {(shown || message?.error) && (
          <footer className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/60 px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
            {shown && message ? (
              <Status message={message} perspective="user" />
            ) : (
              shown && <span>{status}</span>
            )}
            {message?.error && (
              <span className="min-w-0 break-words text-destructive">{message.error}</span>
            )}
          </footer>
        )}
      </div>
    </section>
  )
}

/**
 * Who wrote a bubble, as its header names it: a standing agent by its mark and title in the sans face, anything else
 * as its address.
 */
function Sender({ id, tone }: { id: number; tone: string }) {
  const standing = useDocOf(1, StandingDoc)
  const name = Object.entries(standing ?? {}).find(([, value]) => value === id)?.[0]
  if (!name)
    return (
      <span className={cn('flex min-w-0 font-semibold', tone)}>
        <Address id={id} mark />
      </span>
    )
  return (
    <span className="flex shrink-0 items-center gap-2" title={`@${name}`}>
      <AgentMark name={name} size="sm" />
      <span className={cn('font-sans text-[13px] font-semibold tracking-[-0.005em]', tone)}>
        {agentTitle(name)}
      </span>
    </span>
  )
}

/**
 * Your answer to a question, attached under it as your side of the pair: in your colour, with when you said it. Its
 * arrow jumps to where the answer reached @ultimate.
 */
function AttachedAnswer({ answer, question }: { answer: Message; question: Message }) {
  const now = useNow(60000)
  const accent = accentOf('user')
  const dismissed = question.state === 'dismissed'
  return (
    <div className="border-t border-border/60 px-3 py-2.5" data-compact-answer={answer.id}>
      <div className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
        <CornerDownRightIcon className={cn('size-3.5 shrink-0', accent.name)} />
        <span className={cn('font-semibold', accent.name)}>
          {dismissed ? 'You dismissed it' : 'You answered'}
        </span>
        <time
          className="ml-auto"
          dateTime={new Date(answer.at).toISOString()}
          title={new Date(answer.at).toLocaleString()}
        >
          {formatAgo(answer.at, now)}
        </time>
      </div>
      {!dismissed && (
        <UserText
          className="mt-1.5 rounded-md border border-border/70 bg-secondary/60 px-3 py-2 text-[13px] leading-relaxed"
          text={answer.text}
        />
      )}
    </div>
  )
}

/** A catch-up on the tally and main, the note a conversation gets when it resumes after they moved. */
const catchup = (entry: EntryRecord) =>
  entry.kind === 'lineage.note' && (entry.data as { source?: unknown })?.source === 'main'

/** What one background row is, in a few words that its counterpart follows. */
function backgroundWord(
  { entry, calls }: CompactSummaryProps['rows'][number],
  failed: (call: string) => boolean,
) {
  if (catchup(entry)) return 'Catch-up'
  const words: Record<string, string> = {
    'board.message': 'Message from',
    'board.reply': 'Reply from',
    'lineage.note': 'Note from',
    'lineage.finished': 'Finished:',
    'lineage.abstract': 'Summary of',
    'lineage.woken': 'Woke up after compaction',
    'subagents.report': 'Report from',
    'subagents.instruction': 'Instruction from',
    'workspaces.lander-report': 'Landing report from',
  }
  if (words[entry.kind]) return words[entry.kind]
  if (calls.length) {
    const branches = calls.every((call) => call.name === 'branch')
    // A failed call did not do what its name says.
    if (calls.every((call) => failed(call.id))) return branches ? 'Branch failed' : 'Message failed'
    return branches ? (calls.length === 1 ? 'Started branch' : 'Started branches') : 'Message to'
  }
  return 'Answered'
}

/** A background group's line: who it was with, how many updates, and the work between them. */
export function BackgroundSummary({ rows, steps, working, between }: CompactSummaryProps) {
  const log = useDocOf(1, MessagesDoc) ?? emptyMessages
  const transcript = useTranscript()
  if (between) return <StretchSummary rows={rows} steps={steps} working={working} />
  const shown = rows.filter((row) => backgroundRow(row, log) === true)
  const who = [...new Set(shown.flatMap((row) => counterparts(row, log)))]
  const count = shown.length
  const what =
    count === 1
      ? backgroundWord(shown[0], (call) => callFailed(transcript, call))
      : `${count} updates ${who.length ? 'with' : 'between agents'}`
  const Icon = count === 1 && catchup(shown[0].entry) ? GitBranchIcon : ArrowLeftRightIcon
  return (
    <span className="flex min-w-0 items-center gap-1.5" data-compact-background>
      <Icon className="size-3 shrink-0 text-brand/80" />
      <span className="shrink-0">{what}</span>
      {who.slice(0, 2).map((id) => (
        <span className="flex min-w-0 text-foreground/80" key={id}>
          {id === 'lander' ? '@lander' : <Address id={id} />}
        </span>
      ))}
      {who.length > 2 && <span className="shrink-0">+{who.length - 2}</span>}
      {steps > 0 && (
        <span className="shrink-0 max-sm:hidden">
          · {steps} step{steps === 1 ? '' : 's'}
        </span>
      )}
      {working && <span className="shrink-0 text-brand">· working</span>}
    </span>
  )
}

/**
 * A whole stretch between @ultimate's messages in one line: how many updates, who with, what landed and whether the
 * app reloaded, so the reader knows whether to open it.
 */
function StretchSummary({ rows, steps, working }: CompactSummaryProps) {
  const log = useDocOf(1, MessagesDoc) ?? emptyMessages
  const counted = rows.filter(
    (row) => backgroundRow(row, log) !== 'hidden' && row.entry.kind !== 'pi.system',
  )
  const shas = [
    ...new Set(counted.flatMap((row) => (landed(row.entry) ? [landedSha(row.entry)] : []))),
  ]
  const reloaded = counted.some((row) => row.entry.kind === 'prompt.build')
  const who = [
    ...new Set(
      counted.flatMap((row) => (backgroundRow(row, log) === true ? counterparts(row, log) : [])),
    ),
  ].filter((id) => id !== 'lander')
  const count = counted.length
  const stepped = steps > 0 && `${steps} step${steps === 1 ? '' : 's'}`
  return (
    <span className="flex min-w-0 items-center gap-1.5" data-compact-stretch>
      <span className="shrink-0">
        {count > 0 ? `${count} update${count === 1 ? '' : 's'}` : stepped}
      </span>
      {who.slice(0, 2).map((id) => (
        <span className="flex min-w-0" key={id}>
          <Address id={id} />
        </span>
      ))}
      {who.length > 2 && <span className="shrink-0">+{who.length - 2}</span>}
      {count > 0 && stepped && <span className="shrink-0 max-sm:hidden">· {stepped}</span>}
      {shas.map((sha) => (
        <span className="flex shrink-0 items-center gap-1" key={sha}>
          · <CheckIcon className="size-3 text-success" />
          landed {sha}
        </span>
      ))}
      {reloaded && <span className="shrink-0 max-sm:hidden">· reloaded</span>}
      {working && <span className="shrink-0 text-brand">· working</span>}
    </span>
  )
}

/**
 * The `message` tool as the message it sent; a failed call keeps the generic card with its error. In compact mode, a message
 * to you is a bubble.
 */
export function MessageCall({ call, core }: { call: ToolCallView; core: ReactNode }) {
  const log = useDocOf(1, MessagesDoc)
  const { switchConversation, showSurface } = useUltimate()
  const sender = useConversation((conversation) => conversation.id)
  const caller = useCaller(call.id)
  if (call.status === 'error' || call.status === 'interrupted') return core
  const sent = /^Message (\d+) sent\.$/.exec(call.output)
  const message = sent ? log?.messages.find((m) => m.id === Number(sent[1])) : undefined
  const { to, text, reply, steer } = call.args as {
    to?: string
    text?: string
    reply?: boolean
    steer?: boolean
  }
  const recipient = message?.to ?? (to === 'user' ? 'user' : undefined)
  const toUser = recipient === 'user'
  if (toUser && sender !== undefined)
    return (
      <Bubble
        entry={caller}
        from={sender}
        message={message}
        running={call.status !== 'done'}
        text={text ?? ''}
      >
        {message && <Answers message={message} />}
      </Bubble>
    )
  // Until the model has written any text, the body says it is writing; the card's state would repeat it.
  const writing = call.status !== 'done' && !message && !text
  const state = writing ? undefined : outgoingState(message, toUser, call.status !== 'done')
  const Icon = toUser ? InboxIcon : SendIcon
  return (
    <Fold
      card={call.id}
      summary={
        <>
          <Icon className="size-3 shrink-0 text-brand" />
          <span className="shrink-0">Message to</span>
          <span className="flex min-w-0 text-foreground/80">
            {recipient === undefined ? (
              (to ?? '…')
            ) : (
              <Address id={recipient} remote={message?.remote} />
            )}
          </span>
          {(writing || state) && (
            <span className={cn('shrink-0', state === 'failed' && 'text-destructive')}>
              · {writing ? 'writing' : state}
            </span>
          )}
        </>
      }
    >
      <Card data-message-outgoing={message?.id}>
        <header className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground">
          {toUser ? (
            <InboxIcon className="size-3.5 text-brand" />
          ) : (
            <SendIcon className="size-3.5 text-brand" />
          )}
          <span>Message to</span>
          <span className="flex min-w-0 text-foreground">
            {recipient === undefined ? (
              (to ?? '…')
            ) : (
              <Address id={recipient} remote={message?.remote} />
            )}
          </span>
          <span>
            {(message?.reply ?? reply ?? true) ? 'expects reply' : 'one-way'}
            {steer && ' · steer'}
            {message?.images && ` · ${imageCount(message.images.count)}`}
          </span>
          {state && <span className={state === 'failed' ? 'text-destructive' : ''}>· {state}</span>}
          {message && typeof message.to === 'number' && message.entry !== undefined && (
            <button
              className="ml-auto flex cursor-pointer items-center gap-1 hover:text-foreground"
              onClick={() => {
                events.emit('messages:open', {
                  conversation: message.to,
                  entry: message.entry,
                })
                showSurface('agent')
                switchConversation(message.to as number)
              }}
            >
              <SquareArrowOutUpRightIcon className="size-3" />
              Open
            </button>
          )}
        </header>
        {message?.error && (
          <p className="border-b border-border/60 px-3 py-1.5 font-mono text-[11px] break-words text-destructive">
            {message.error}
          </p>
        )}
        <Body pending={writing ? 'Writing a message…' : undefined} text={text ?? ''} />
        {message && <Answers message={message} />}
      </Card>
    </Fold>
  )
}

/** The `branch` tool as the branch it started and the prompt it was given; a failed call keeps the generic card. */
export function BranchCall({ call, core }: { call: ToolCallView; core: ReactNode }) {
  const log = useDocOf(1, MessagesDoc)
  const conversations = useConversations()
  const { switchConversation, showSurface } = useUltimate()
  if (call.status === 'error' || call.status === 'interrupted') return core
  // Results from before the title was named lack the quoted part.
  const started = /^Branch #(\d+)(?: ".*")? started; message (\d+) sent\.$/.exec(call.output)
  const id = started ? Number(started[1]) : undefined
  const message = started ? log?.messages.find((m) => m.id === Number(started[2])) : undefined
  const { prompt, root, isolated } = call.args as {
    prompt?: string
    root?: number
    isolated?: boolean
  }
  const state =
    id === undefined
      ? 'starting'
      : message?.state === 'failed'
        ? 'failed'
        : message?.state === 'stopped'
          ? 'stopped by the user'
          : message?.state === 'answered'
            ? 'reported back'
            : 'working'
  return (
    <Fold
      card={call.id}
      summary={
        <>
          <GitBranchIcon className="size-3 shrink-0 text-brand" />
          <span className="shrink-0">Branch</span>
          {id !== undefined && (
            <span className="flex min-w-0 text-foreground/80">
              <ConversationRef
                id={id}
                title={conversations.find((conversation) => conversation.id === id)?.title}
              />
            </span>
          )}
          <span className={cn('shrink-0', state === 'failed' && 'text-destructive')}>
            · {state}
          </span>
        </>
      }
    >
      <Card data-message-branch={id}>
        <header className="flex items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px] whitespace-nowrap text-muted-foreground">
          <GitBranchIcon className="size-3.5 shrink-0 text-brand" />
          <span className="shrink-0">
            <span className="max-sm:hidden">Started branch · coordinator</span>
            <span className="sm:hidden">Branch</span>
          </span>
          {id !== undefined && (
            <span className="flex min-w-0 overflow-hidden text-foreground">
              <ConversationRef
                className="w-full"
                id={id}
                title={conversations.find((conversation) => conversation.id === id)?.title}
              />
            </span>
          )}
          <span className="shrink-0 max-sm:hidden">
            {root !== undefined && `from #${root} · `}
            {(isolated ?? true) ? 'isolated' : 'shared'}
            {message?.images && ` · ${imageCount(message.images.count)}`}
          </span>
          <span className={`shrink-0 ${state === 'failed' ? 'text-destructive' : ''}`}>
            · {state}
          </span>
          {id !== undefined && (
            <button
              className="ml-auto flex shrink-0 cursor-pointer items-center gap-1 hover:text-foreground"
              onClick={() => {
                if (message?.entry !== undefined)
                  events.emit('messages:open', {
                    conversation: id,
                    entry: message.entry,
                  })
                showSurface('agent')
                switchConversation(id)
              }}
            >
              <SquareArrowOutUpRightIcon className="size-3" />
              Open
            </button>
          )}
        </header>
        {message?.error && (
          <p className="border-b border-border/60 px-3 py-1.5 font-mono text-[11px] break-words text-destructive">
            {message.error}
          </p>
        )}
        <Body text={prompt ?? ''} />
      </Card>
    </Fold>
  )
}

export function MessageInput({ entry }: { entry: EntryRecord }) {
  const origin = entry.data as {
    id: number
    from: number | 'user' | 'remote'
    text: string
    reply: boolean
    delivery?: 'steer' | 'followUp' | 'note'
    failed?: boolean
    stopped?: boolean
    remote?: Remote
  }
  const receiver = useConversation((conversation) => conversation.id)
  const { switchConversation } = useUltimate()
  const reply = entry.kind === 'board.reply'
  const accent = useAccentOf(origin.from)
  if (origin.from === 'user') return <UserTurn entry={entry} id={origin.id} text={origin.text} />
  return (
    <Fold
      card={entry.id}
      summary={
        <>
          <MailIcon className={cn('size-3 shrink-0', accent.name)} />
          <span className={cn('flex min-w-0', accent.name)}>
            <Address id={origin.from} remote={origin.remote} />
          </span>
          <span className="shrink-0">
            {reply ? 'reply' : origin.reply ? 'message · expects reply' : 'message · one-way'}
          </span>
          {origin.stopped ? (
            <span className="shrink-0">· stopped by the user</span>
          ) : (
            origin.failed && <span className="shrink-0 text-destructive">· failed</span>
          )}
          {origin.delivery === 'note' && (
            <span className="shrink-0 text-muted-foreground/60">· note</span>
          )}
        </>
      }
    >
      <section
        data-message-input={origin.id}
        className={cn('group/bubble min-w-0 rounded-lg border', accent.edge, accent.fill)}
      >
        <header className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground">
          <MailIcon className={cn('size-3.5 shrink-0', accent.name)} />
          <span className={cn('flex min-w-0 font-semibold', accent.name)}>
            <Address id={origin.from} mark remote={origin.remote} />
          </span>
          <span>{reply ? 'Reply' : 'Message'}</span>
          {!reply && (
            <span>
              {origin.reply ? 'expects reply' : 'one-way'}
              {origin.delivery &&
                ` · ${{ steer: 'steered', followUp: 'follow-up', note: 'note' }[origin.delivery]}`}
            </span>
          )}
          {origin.stopped ? (
            <span>stopped by the user</span>
          ) : (
            origin.failed && <span className="text-destructive">failed</span>
          )}
          {typeof origin.from === 'number' && (
            <button
              className="ml-auto flex cursor-pointer items-center gap-1 hover:text-foreground"
              onClick={() =>
                receiver &&
                typeof origin.from === 'number' &&
                openAgentSource(
                  switchConversation,
                  { conversation: origin.from },
                  { conversation: receiver },
                )
              }
            >
              <SquareArrowOutUpRightIcon className="size-3" />
              Source
            </button>
          )}
        </header>
        <Body text={origin.text} />
        <InputImages entry={entry} />
      </section>
    </Fold>
  )
}

/**
 * What you said through messaging, in compact mode: a turn of yours like a typed one. An answer to a question that shows it
 * already is a one-line reference to that question instead.
 */
function UserTurn({ entry, id, text }: { entry: EntryRecord; id: number; text: string }) {
  const log = useDocOf(1, MessagesDoc)
  const transcript = useTranscript()
  const message = log?.messages.find((m) => m.id === id)
  const question =
    message?.re === undefined ? undefined : log?.messages.find((m) => m.id === message.re)
  // The response that asked it, where the question shows with your answer under it.
  const asked = question?.call && callerOf(transcript, question.call.split('/')[0])
  const input = entry.model?.[0]
  if (question && asked) {
    return (
      <button
        className="ml-auto flex cursor-pointer items-center gap-1.5 font-mono text-[11px] text-muted-foreground/70 hover:text-muted-foreground"
        data-compact-answer-ref={id}
        onClick={() =>
          events.emit('ultimate:reveal-entry', {
            conversationId: asked.conversationId,
            entryId: asked.id,
          })
        }
        title="Show the question and your answer"
        type="button"
      >
        <CornerLeftUpIcon className="size-3" />
        {question.state === 'dismissed' ? 'you dismissed a question' : 'you answered a question'}
      </button>
    )
  }
  // Its input wraps your words for the agent; show them as you wrote them, with the images it carries.
  return input?.role === 'user' ? <UserView entry={entry} message={input} text={text} /> : null
}

/** The loaded response that made tool call `call`. */
const useCaller = (call: string) => callerOf(useTranscript(), call)

const imageCount = (count: number) => `${count} image${count === 1 ? '' : 's'}`

/** Images forwarded with a message, from its input's model content, as thumbnails that open full size. */
const InputImages = ({ entry }: { entry: EntryRecord }) => <Thumbnails images={imagesOf(entry)} />

/**
 * The images a message to you carries: they stay in the sender's entry `entry` (a screenshot, a pasted input), read from
 * the loaded transcript or else fetched from its stored history.
 */
function MessageImages({ conversation, entry }: { conversation: number; entry: number }) {
  const loaded = useTranscript().find(
    (item) => item.conversationId === conversation && item.id === entry,
  )
  const [fetched, setFetched] = useState<EntryRecord>()
  useEffect(() => {
    if (loaded) return undefined
    const controller = new AbortController()
    api.history(conversation, entry + 1, controller.signal, entry).then(
      (page) => setFetched(page.entries.find((item) => item.id === entry)),
      // Without its entry the message still reads; only the thumbnails are missing.
      () => undefined,
    )
    return () => controller.abort()
  }, [conversation, entry, loaded])
  return <Thumbnails images={imagesOf(loaded ?? fetched)} />
}

function Thumbnails({ images }: { images: readonly { data: string; mimeType: string }[] }) {
  if (!images.length) return null
  return (
    <div className="flex flex-wrap gap-2 border-t border-border/60 px-3 py-2">
      {images.map((image, index) => (
        // oxlint-disable-next-line react/no-array-index-key -- Fixed forwarded attachments may contain duplicates.
        <ToolImage alt={`Forwarded image ${index + 1}`} image={image} key={index} />
      ))}
    </div>
  )
}

/**
 * In compact mode, an answer that went back to the conversations that asked, not to you, folds to one line, and a `codemode`
 * script that messaged you shows each message as a bubble.
 */
export function CompactAnswer({
  entry,
  core,
  blocks,
}: {
  entry: EntryRecord
  core: ReactNode
  blocks?: readonly number[]
}) {
  const compact = useCompact()
  const message = entry.model?.[0]
  if (!compact || message?.role !== 'assistant') return core
  if (message.stopReason === 'stop') {
    const text = message.content
      .flatMap((block) => (block.type === 'text' && block.text.trim() ? [block.text] : []))
      .join('\n\n')
    return <ReplyFold entry={entry} core={core} text={text} at={message.timestamp} />
  }
  const shown = (blocks ?? message.content.map((_, index) => index)).flatMap((index) => {
    const block = message.content[index]
    return block?.type === 'toolCall' ? [block] : []
  })
  if (!shown.some((block) => block.name === 'codemode')) return core
  return <ScriptMessages core={core} entry={entry} shown={shown} />
}

/**
 * The messages to you that the shown `codemode` calls sent, as bubbles beneath a quiet line that opens the calls; the
 * calls stay open above them when the row also shows other tools.
 */
function ScriptMessages({
  entry,
  core,
  shown,
}: {
  entry: EntryRecord
  core: ReactNode
  shown: readonly { id: string; name: string }[]
}) {
  const log = useDocOf(1, MessagesDoc) ?? emptyMessages
  const sent = shown.flatMap((block) =>
    block.name === 'codemode' ? sentBy(log.messages, block.id) : [],
  )
  if (!sent.length) return core
  const bubbles = sent.map((message) => (
    <Bubble
      entry={entry}
      from={entry.conversationId}
      key={message.id}
      message={message}
      running={false}
      text={message.text}
    >
      <Answers message={message} />
    </Bubble>
  ))
  if (shown.some((block) => block.name !== 'codemode'))
    return (
      <div className="flex min-w-0 flex-col gap-3">
        {core}
        {bubbles}
      </div>
    )
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <Collapsible className="group/script">
        <CollapsibleTrigger className="flex cursor-pointer items-center gap-1.5 font-mono text-[11px] text-muted-foreground/70 hover:text-muted-foreground">
          sent with codemode
          <ChevronRightIcon className="size-3 transition-transform group-data-[state=open]/script:rotate-90" />
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-3">{core}</CollapsibleContent>
      </Collapsible>
      {bubbles}
    </div>
  )
}

function ReplyFold({
  entry,
  core,
  text,
  at,
}: {
  entry: EntryRecord
  core: ReactNode
  text: string
  at: number
}) {
  const log = useDocOf(1, MessagesDoc) ?? emptyMessages
  const answered = answeredMessages(log.messages, entry.conversationId, entry.id)
  if (!answered.length || answered.some((m) => !m.reply || m.from === 'user'))
    // An answer to you is a bubble like its messages, not a final-answer card.
    return text ? (
      <Bubble
        at={at}
        entry={entry}
        from={entry.conversationId}
        message={undefined}
        running={false}
        text={text}
      />
    ) : (
      core
    )
  return (
    <Collapsible className="group/reply">
      <CollapsibleTrigger className="flex cursor-pointer flex-wrap items-center gap-1.5 font-mono text-[11px] text-muted-foreground/70 hover:text-muted-foreground">
        replied to
        {answered.map((m) => (
          <span className="flex min-w-0" key={m.id}>
            <Address id={m.from} remote={m.remote} />
          </span>
        ))}
        <ChevronRightIcon className="size-3 transition-transform group-data-[state=open]/reply:rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-3">{core}</CollapsibleContent>
    </Collapsible>
  )
}
