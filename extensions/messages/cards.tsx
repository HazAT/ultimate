import { parseConversationId, offsetEntryId } from '../../lib/ids.ts'
import type { EntryRecord, ConversationId, EntryId } from '@earendil-works/pi-durable'
import { ROOT } from '@/sdk'
import {
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
  AllProvided,
  api,
  Card,
  cn,
  events,
  Fold,
  formatAgo,
  formatTokens,
  MessageActions,
  Provided,
  useCompact,
  useConversation,
  useConversationSummary,
  useDocOf,
  useNow,
  useTranscript,
  useUltimate,
  UserText,
  UserView,
} from '@/sdk'
import type { CompactSummaryProps, ToolCallView } from '@/sdk'
import { AgentMark, AgentTitle, ConversationRef, useAgentTitle } from '../conversations/ui.tsx'
import { openAgentSource, StandingDoc } from '../subagents/ui.tsx'
import { useWorkspaceIndex } from '../workspaces/ui.tsx'
import { accentOf } from './accent.tsx'
import {
  answerTo,
  answeredMessages,
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
import { cacheBusts } from '../../lib/context-usage.ts'
import { imagesOf } from '../../lib/entries.ts'
import { callerOf } from './caller.ts'
import { MessagesDoc } from './refs.ts'
import { MessageEntry, ReplyEntry } from '../entries/ui.tsx'
import type { Message, Remote } from './refs.ts'
import { MessageAnswers, MessageExtras } from './points.tsx'

const Answers = ({ message }: { message: Message }) => (
  <>
    <AllProvided input={message} point={MessageExtras}>
      {(extras) => extras}
    </AllProvided>
    <Provided input={message} point={MessageAnswers}>
      {(answers) => answers}
    </Provided>
  </>
)

const settledLabel = (question: Message, answer: Message) =>
  question.state === 'dismissed'
    ? answer.via
      ? '@ultimate dismissed it for you'
      : 'You dismissed it'
    : answer.via
      ? '@ultimate answered for you'
      : 'You answered'

export function useAccentOf(id: number | 'user' | 'remote') {
  const standing = useDocOf(ROOT, StandingDoc)
  return accentOf(standing?.ultimate === id ? 'ultimate' : id)
}

export function Address({
  id,
  mark = false,
  remote,
}: {
  id: ConversationId | 'user' | 'remote'
  mark?: boolean
  remote?: Pick<Remote, 'project' | 'machine'>
}) {
  const standing = useDocOf(ROOT, StandingDoc)
  const workspaces = useWorkspaceIndex()
  const ultimate = useAgentTitle('ultimate')
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
        {ultimate.brand ? (
          <span
            className="font-sans text-[10.5px] font-semibold tracking-[0.28em]"
            data-ui="wordmark"
          >
            ULTIMATE
          </span>
        ) : (
          <span className="font-sans text-[12px] font-semibold">{ultimate.title}</span>
        )}
      </span>
    )
  return (
    <span className="flex items-center gap-1.5">
      {mark && <AgentMark name={name} size="sm" />}@{name}
    </span>
  )
}

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

function Status({
  message,
  perspective,
}: {
  message: Message
  perspective: ConversationId | 'user'
}) {
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
  from: ConversationId
  message: Message | undefined
  text?: string
  running: boolean
  entry?: EntryRecord
  at?: number
  lead?: ReactNode
  children?: ReactNode
}) {
  const now = useNow(60000)
  const log = useDocOf(ROOT, MessagesDoc)
  const accent = useAccentOf(from)
  const status = sentStatus(message, running)
  const stored = entry?.model?.[0]
  const answer = message && log ? answerTo(log.messages, message) : undefined

  const bodyAlreadyShowsWriting = running && !message && !text

  const showAttentionOrFailureStatus =
    status === 'yours' ||
    (status === 'sending' && !bodyAlreadyShowsWriting) ||
    status === 'failed' ||
    status === 'stopped' ||
    status === 'dismissed'

  return (
    <section
      data-message-outgoing={message?.id}
      data-compact-bubble
      data-sender={accent === accentOf('ultimate') ? 'ultimate' : undefined}
      data-ui="message-card"
      className="group/bubble mt-2 w-full min-w-0"
    >
      <header className="flex h-6 min-w-0 items-center gap-2 font-mono text-[11px] text-muted-foreground">
        <Sender id={from} tone={accent.name} />
        {entry ? (
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
          <Body
            pending={bodyAlreadyShowsWriting ? 'Writing you a message…' : undefined}
            text={text}
          />
        )}
      </div>
      <div
        className="mt-3 overflow-hidden rounded-lg border border-border/70 bg-card/60 empty:hidden [&>:first-child]:border-t-0"
        data-ui="message-card-body"
      >
        {message?.images && <MessageImages conversation={from} entry={message.images.entry} />}
        {children}
        {answer && <AttachedAnswer answer={answer} question={message!} />}
        {(showAttentionOrFailureStatus || message?.error) && (
          <footer className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/60 px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
            {showAttentionOrFailureStatus && message ? (
              <Status message={message} perspective="user" />
            ) : (
              showAttentionOrFailureStatus && <span>{status}</span>
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

function Sender({ id, tone }: { id: ConversationId; tone: string }) {
  const standing = useDocOf(ROOT, StandingDoc)
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
        <AgentTitle name={name} />
      </span>
    </span>
  )
}

function AttachedAnswer({ answer, question }: { answer: Message; question: Message }) {
  const now = useNow(60000)
  const accent = accentOf('user')
  const dismissed = question.state === 'dismissed'
  const { via } = answer
  const { showSurface, switchConversation } = useUltimate()
  return (
    <div className="border-t border-border/60 px-3 py-2.5" data-compact-answer={answer.id}>
      <div className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
        <CornerDownRightIcon className={cn('size-3.5 shrink-0', accent.name)} />
        <span className={cn('font-semibold', accent.name)}>{settledLabel(question, answer)}</span>
        {via?.entry !== undefined && (
          <button
            className="flex cursor-pointer items-center gap-1 hover:text-foreground"
            data-settled-from={via.entry}
            onClick={() => {
              events.emit('messages:open', { conversation: via.conversation, entry: via.entry })
              showSurface('agent')
              switchConversation(via.conversation)
            }}
            title="Show what you said that @ultimate read this from"
            type="button"
          >
            <SquareArrowOutUpRightIcon className="size-3" />
            from your message
          </button>
        )}
        <time
          className="ml-auto"
          dateTime={new Date(answer.at).toISOString()}
          title={new Date(answer.at).toLocaleString()}
        >
          {formatAgo(answer.at, now)}
        </time>
      </div>
      {(!dismissed || via) && (
        <UserText
          className="mt-1.5 rounded-md border border-border/70 bg-secondary/60 px-3 py-2 text-[13px] leading-relaxed"
          text={answer.text}
        />
      )}
    </div>
  )
}

export function StretchSummary({ rows, steps, working, entries }: CompactSummaryProps) {
  const log = useDocOf(ROOT, MessagesDoc) ?? emptyMessages

  const transcriptWideCacheBusts = cacheBusts(useTranscript())

  const uniqueResponseIds = [...new Set(entries.map((entry) => entry.id))]
  const written = uniqueResponseIds.reduce(
    (sum, id) => sum + (transcriptWideCacheBusts.get(id)?.written ?? 0),
    0,
  )
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
  const named = who.slice(0, who.length > 2 ? 1 : 2)
  const stepped = steps > 0 && `${steps} step${steps === 1 ? '' : 's'}`
  return (
    <span className="flex min-w-0 items-center gap-1.5" data-compact-stretch>
      <span className="shrink-0">
        {count > 0 ? `${count} update${count === 1 ? '' : 's'}` : stepped}
      </span>
      {named.map((id) => (
        <span className="flex min-w-0 overflow-hidden" key={id}>
          <Address id={id} />
        </span>
      ))}
      {who.length > named.length && <span className="shrink-0">+{who.length - named.length}</span>}
      {count > 0 && stepped && <span className="shrink-0 max-sm:hidden">· {stepped}</span>}
      {shas.length > 0 && (
        <span className="flex shrink-0 items-center gap-1" title={shas.join(' ')}>
          · <CheckIcon className="size-3 text-success" />
          {shas.length === 1 ? `landed ${shas[0]}` : `${shas.length} landed`}
        </span>
      )}
      {reloaded && <span className="shrink-0 max-sm:hidden">· reloaded</span>}
      {written > 0 && (
        <span className="shrink-0 text-warning/80" data-cache-rebuilt={written}>
          · cache rebuilt · {formatTokens(written)} written
        </span>
      )}
      {working && <span className="shrink-0 text-brand">· working</span>}
    </span>
  )
}

export function MessageCall({ call, core }: { call: ToolCallView; core: ReactNode }) {
  const log = useDocOf(ROOT, MessagesDoc)
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

  const bodyAlreadyShowsWriting = call.status !== 'done' && !message && !text
  const state = bodyAlreadyShowsWriting
    ? undefined
    : outgoingState(message, toUser, call.status !== 'done')
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
          {(bodyAlreadyShowsWriting || state) && (
            <span className={cn('shrink-0', state === 'failed' && 'text-destructive')}>
              · {bodyAlreadyShowsWriting ? 'writing' : state}
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
          {message && typeof recipient === 'number' && message.entry !== undefined && (
            <button
              className="ml-auto flex cursor-pointer items-center gap-1 hover:text-foreground"
              onClick={() => {
                events.emit('messages:open', {
                  conversation: recipient,
                  entry: message.entry,
                })
                showSurface('agent')
                switchConversation(recipient)
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
        <Body
          pending={bodyAlreadyShowsWriting ? 'Writing a message…' : undefined}
          text={text ?? ''}
        />
        {message && <Answers message={message} />}
      </Card>
    </Fold>
  )
}

export function BranchCall({ call, core }: { call: ToolCallView; core: ReactNode }) {
  const log = useDocOf(ROOT, MessagesDoc)
  const { switchConversation, showSurface } = useUltimate()
  const started = /^Branch #(\d+) started; message (\d+) sent\.$/.exec(call.output)
  const id = started ? parseConversationId(Number(started[1])) : undefined
  const title = useConversationSummary(id)?.title
  if (call.status === 'error' || call.status === 'interrupted') return core
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
              <ConversationRef id={id} title={title} />
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
              <ConversationRef className="w-full" id={id} title={title} />
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
  const origin = MessageEntry.is(entry) || ReplyEntry.is(entry) ? entry.data : undefined
  const receiver = useConversation((conversation) => conversation.id)
  const { switchConversation } = useUltimate()
  const reply = entry.kind === 'board.reply'
  const accent = useAccentOf(origin?.from ?? 'user')
  if (!origin) return null
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
        data-sender={accent === accentOf('ultimate') ? 'ultimate' : undefined}
        data-ui="message-card"
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

function UserTurn({ entry, id, text }: { entry: EntryRecord; id: number; text: string }) {
  const log = useDocOf(ROOT, MessagesDoc)
  const transcript = useTranscript()
  const message = log?.messages.find((m) => m.id === id)
  const question =
    message?.re === undefined ? undefined : log?.messages.find((m) => m.id === message.re)

  const askedWithAttachedAnswer =
    question?.call && callerOf(transcript, question.call.split('/')[0])
  const input = entry.model?.[0]
  if (question && askedWithAttachedAnswer) {
    return (
      <button
        className="ml-auto flex cursor-pointer items-center gap-1.5 font-mono text-[11px] text-muted-foreground/70 hover:text-muted-foreground"
        data-compact-answer-ref={id}
        onClick={() =>
          events.emit('ultimate:reveal-entry', {
            conversationId: askedWithAttachedAnswer.conversationId,
            entryId: askedWithAttachedAnswer.id,
            toolCallId: question.call?.split('/')[0],
          })
        }
        title="Show the question and your answer"
        type="button"
      >
        <CornerLeftUpIcon className="size-3" />
        {question.state === 'dismissed'
          ? message?.via
            ? '@ultimate dismissed a question for you'
            : 'you dismissed a question'
          : message?.via
            ? '@ultimate answered a question for you'
            : 'you answered a question'}
      </button>
    )
  }

  return input?.role === 'user' ? <UserView entry={entry} message={input} text={text} /> : null
}

const useCaller = (call: string) => callerOf(useTranscript(), call)

const imageCount = (count: number) => `${count} image${count === 1 ? '' : 's'}`

const InputImages = ({ entry }: { entry: EntryRecord }) => <Thumbnails images={imagesOf(entry)} />

export function MessageImages({
  conversation,
  entry,
}: {
  conversation: ConversationId
  entry: EntryId
}) {
  const loaded = useTranscript().find(
    (item) => item.conversationId === conversation && item.id === entry,
  )
  const [fetched, setFetched] = useState<EntryRecord>()
  useEffect(() => {
    if (loaded) return undefined
    const controller = new AbortController()
    api.history(conversation, offsetEntryId(entry, 1), controller.signal, entry).then(
      (page) => setFetched(page.entries.find((item) => item.id === entry)),
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
        <ToolImage alt={`Forwarded image ${index + 1}`} image={image} key={index} />
      ))}
    </div>
  )
}

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
  const shownToolBlocks = (blocks ?? message.content.map((_, index) => index)).flatMap((index) => {
    const block = message.content[index]
    return block?.type === 'toolCall' ? [block] : []
  })
  if (!shownToolBlocks.some((block) => block.name === 'codemode')) return core
  return <ScriptMessages core={core} entry={entry} shown={shownToolBlocks} />
}

function ScriptMessages({
  entry,
  core,
  shown,
}: {
  entry: EntryRecord
  core: ReactNode
  shown: readonly { id: string; name: string }[]
}) {
  const log = useDocOf(ROOT, MessagesDoc) ?? emptyMessages
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
  const log = useDocOf(ROOT, MessagesDoc) ?? emptyMessages
  const answered = answeredMessages(log.messages, entry.conversationId, entry.id)
  if (!answered.length || answered.some((m) => !m.reply || m.from === 'user'))
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
