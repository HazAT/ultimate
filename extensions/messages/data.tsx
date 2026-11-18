import { parseConversationId } from '../../lib/ids.ts'
import { formatTime } from '@/sdk'
import { waitsOn } from '../../lib/waits.ts'
import type { Wait, WaitFacts } from '../../lib/waits.ts'
import type { EntryRecord, ConversationId } from '@earendil-works/pi-durable'
import { isOpen, isOwed, openQuestion } from '../../lib/message-state.ts'
import type { MessagesData, Message, Remote, RemoteProgress } from './refs.ts'
import { MessageEntry, NoteEntry, ReplyEntry } from '../entries/ui.tsx'
import { FinishedEntry, AbstractEntry } from '../lineage/ui.tsx'
import { LanderReportEntry } from '../workspaces/ui.tsx'
import { InstructionEntry, ReportEntry } from '../subagents/ui.tsx'

export { isOpen, isOwed, openQuestion }

export const remoteLabel = (remote: Pick<Remote, 'project' | 'machine'>) =>
  `@ultimate@${remote.project} on ${remote.machine}`

export function answeredMessages(messages: Message[], conversation: ConversationId, entry: number) {
  return messages.filter((message) => message.to === conversation && message.answer === entry)
}

export const emptyMessages: MessagesData = { messages: [], next: 1 }

export const waitingOnUser = (log: MessagesData) => log.messages.filter(openQuestion).length

export type ConversationState =
  | 'paused'
  | 'working'
  | 'waits'
  | 'awaiting'
  | 'done'
  | 'failed'
  | 'idle'

type Conversation = {
  id: number
  kind: 'primary' | 'subagent' | 'other'
  runState?: 'working' | 'queued' | 'idle' | 'answered' | 'error'
  busy?: boolean
  parked?: boolean
  concludedSince?: number
  starter?: number
}

export function conversationWait(
  conversation: Conversation,
  log: MessagesData,
  automations?: WaitFacts['automations'],
) {
  return waitsOn(conversation.id, {
    working:
      conversation.busy ||
      conversation.runState === 'working' ||
      conversation.runState === 'queued',
    messages: log.messages,
    automations,
    starter: conversation.starter,
    concluded: conversation.concludedSince === Infinity,
  })
}

export function conversationState(
  conversation: Conversation,
  log: MessagesData,
  automations?: WaitFacts['automations'],
): ConversationState {
  const { id, kind, runState } = conversation
  if (conversation.parked) return 'paused'
  const userActionTakesPriority =
    kind === 'primary'
      ? waitingOnUser(log) > 0
      : kind === 'other' && log.messages.some((m) => m.from === id && openQuestion(m))
  if (userActionTakesPriority) return 'waits'
  const wait = conversationWait(conversation, log, automations)
  if (wait?.on === 'work') return 'working'
  if (runState === 'error') return 'failed'
  if (kind !== 'subagent' && wait && wait.on !== 'user') return 'awaiting'
  if (kind === 'subagent' && runState === 'answered') return 'done'
  return 'idle'
}

export function waitLabel(
  wait: Wait | undefined,
  primary?: number,
  primaryWait?: Wait,
  remote?: RemoteProgress,
) {
  if (!wait) return undefined
  const suffix =
    remote?.reachable === false
      ? ' · not running'
      : remote?.progress
        ? ` · ${remote.progress.label} ${remote.progress.index}/${remote.progress.total}`
        : ''
  switch (wait.on) {
    case 'work':
      return 'working'
    case 'user':
      return 'waits on you'
    case 'agent':
    case 'starter':
      return wait.to === primary
        ? `waits on @ultimate${primaryWait?.on === 'remote' ? ` → ${primaryWait.project}${suffix}` : ''}`
        : `waits on #${wait.to}`
    case 'remote':
      return `waits on ${wait.project}${suffix}`
    case 'timer':
      return `waits on ${wait.name} · ${formatTime(wait.at)}`
  }
  return undefined
}

export function stateWord(state: ConversationState, waiting = 0, label?: string) {
  if (state === 'waits') return waiting > 0 ? `${waiting} waiting on you` : 'waits on you'
  return state === 'awaiting' ? (label ?? 'waiting') : state
}

export const stateTone: Partial<Record<ConversationState, string>> = {
  paused: 'text-warning',
  working: 'text-brand',
  waits: 'text-amber-700 dark:text-amber-300',
  awaiting: 'text-brand',
  done: 'text-success',
  failed: 'text-error',
}

export const ultimateCompact = (
  conversation: { id: number },
  standing: Readonly<Record<string, unknown>> | null | undefined,
) => standing?.ultimate === conversation.id

export const sentBy = (messages: readonly Message[], call: string) =>
  messages.filter(
    (message) =>
      message.to === 'user' &&
      message.call !== undefined &&
      (message.call === call || message.call.startsWith(`${call}/`)),
  )

export const scriptMessaged = (
  call: { id: string; name: string },
  log: Readonly<MessagesData> | null | undefined,
) => call.name === 'codemode' && sentBy(log?.messages ?? [], call.id).length > 0

const hiddenUncountedCompactKinds = new Set([
  'board.wake',
  'board.open',
  'board.answered',
  'setup.note',
  'questions.asked',
  'questions.answers',
])

const agentTrafficKinds = new Set([
  'lineage.note',
  'lineage.finished',
  'lineage.abstract',
  'lineage.woken',
  'subagents.report',
  'subagents.instruction',
  'workspaces.lander-report',
])

export function backgroundRow(
  {
    entry,
    calls,
  }: { entry: EntryRecord; calls: readonly { id: string; name: string; arguments: unknown }[] },
  log: Readonly<MessagesData> | null | undefined,
): boolean | 'hidden' {
  if (hiddenUncountedCompactKinds.has(entry.kind)) return 'hidden'
  if (landed(entry)) return false
  if (agentTrafficKinds.has(entry.kind)) return true
  if (MessageEntry.is(entry) || ReplyEntry.is(entry)) {
    const data: { from?: unknown } | undefined = entry.data
    return data?.from !== 'user'
  }
  const message = entry.model?.[0]
  if (entry.kind !== 'pi.assistant' || message?.role !== 'assistant') return false
  if (calls.length)
    return calls.every(
      (call) =>
        call.name === 'branch' ||
        (call.name === 'message' &&
          (call.arguments as { to?: unknown } | undefined)?.to !== 'user'),
    )
  if (message.stopReason !== 'stop') return false
  if (routedTo(log?.messages ?? [], entry).length) return true
  const answered = answeredMessages(log?.messages ?? [], entry.conversationId, entry.id)
  return answered.length > 0 && answered.every((m) => m.reply && m.from !== 'user')
}

const routedTo = (messages: readonly Message[], entry: EntryRecord) =>
  messages.filter((m) => m.from === entry.conversationId && m.routed === entry.id)

export function threadRow(
  row: { entry: EntryRecord; calls: readonly { id: string; name: string; arguments: unknown }[] },
  log: Readonly<MessagesData> | null | undefined,
): boolean | 'hidden' {
  const { entry, calls } = row
  if (hiddenUncountedCompactKinds.has(entry.kind) || entry.kind === 'pi.system') return 'hidden'
  if (entry.kind === 'pi.user') return true
  const userSentSummaryOfTheirSideChat = entry.kind === 'sidechat.summary'
  if (userSentSummaryOfTheirSideChat) return true
  if (MessageEntry.is(entry) || ReplyEntry.is(entry)) {
    const data: { from?: unknown } | undefined = entry.data
    return data?.from === 'user'
  }
  if (entry.kind !== 'pi.assistant' || backgroundRow(row, log) !== false) return false
  if (calls.length)
    return calls.some(
      (call) =>
        scriptMessaged(call, log) ||
        (call.name === 'message' &&
          (call.arguments as { to?: unknown } | undefined)?.to === 'user'),
    )

  const message = entry.model?.[0]
  return (
    message?.role === 'assistant' &&
    (message.stopReason === 'stop' || message.stopReason === 'error')
  )
}

export function landedSha(entry: EntryRecord): string | undefined {
  const data: { source?: unknown; sha?: unknown; outcome?: { sha?: unknown } } | undefined =
    NoteEntry.is(entry) || LanderReportEntry.is(entry) ? entry.data : undefined
  const sha = NoteEntry.is(entry) ? data?.sha : data?.outcome?.sha
  return typeof sha === 'string' ? sha.slice(0, 7) : undefined
}

const idOf = (value: unknown): (ConversationId | 'remote')[] =>
  typeof value === 'number' ? [parseConversationId(value)] : value === 'remote' ? [value] : []

export function landed(entry: EntryRecord) {
  const data: { source?: unknown; outcome?: { outcome?: unknown } } | undefined =
    NoteEntry.is(entry) || LanderReportEntry.is(entry) ? entry.data : undefined
  if (NoteEntry.is(entry)) return data?.source === 'lander'
  return LanderReportEntry.is(entry) && data?.outcome?.outcome === 'landed'
}

export function counterparts(
  {
    entry,
    calls,
  }: { entry: EntryRecord; calls: readonly { id: string; name: string; arguments: unknown }[] },
  log: Readonly<MessagesData>,
): (ConversationId | 'remote' | 'lander')[] {
  switch (entry.kind) {
    case 'board.message':
    case 'board.reply':
    case 'lineage.finished': {
      if (!MessageEntry.is(entry) && !ReplyEntry.is(entry) && !FinishedEntry.is(entry)) return []
      const data: { from?: unknown } | undefined = entry.data
      return idOf(data?.from)
    }
    case 'lineage.note': {
      if (!NoteEntry.is(entry)) return []
      const data: { source?: unknown; from?: unknown } | undefined = entry.data
      return data?.source === 'lander' ? ['lander'] : idOf(data?.from)
    }
    case 'lineage.abstract': {
      if (!AbstractEntry.is(entry)) return []
      const data: { conversation?: unknown } | undefined = entry.data
      return idOf(data?.conversation)
    }
    case 'subagents.report':
    case 'subagents.instruction': {
      if (!InstructionEntry.is(entry) && !ReportEntry.is(entry)) return []
      const data: { sender?: unknown } | undefined = entry.data
      return idOf(data?.sender)
    }
    case 'workspaces.lander-report':
      return ['lander']
  }
  if (calls.length)
    return calls.flatMap((call) => {
      const sent = log.messages.find((m) => m.call === call.id)
      if (sent) return idOf(sent.to)
      const to = /^#(\d+)$/.exec(String((call.arguments as { to?: unknown } | undefined)?.to))
      return to ? [parseConversationId(Number(to[1]))] : []
    })
  return [
    ...answeredMessages(log.messages, entry.conversationId, entry.id).flatMap((m) => idOf(m.from)),
    ...routedTo(log.messages, entry).flatMap((m) => idOf(m.to)),
  ]
}

export const answerTo = (messages: readonly Message[], question: Message) =>
  messages.find((m) => m.from === 'user' && m.re === question.id)

export function openMessages(
  messages: readonly Message[],
  id: number,
  branches: readonly {
    id: number
    starter?: number
    working?: boolean
    concluded?: boolean
  }[] = [],
  automations?: WaitFacts['automations'],
) {
  const owedBranches = branches.filter((branch) => {
    const wait = waitsOn(branch.id, { ...branch, messages, automations })
    return (
      !branch.concluded &&
      branch.starter === id &&
      (wait?.on === 'starter' || wait?.on === 'agent') &&
      wait.to === id
    )
  })
  return {
    waiting: messages.filter((m) => m.from === id && isOwed(m)),
    requests: messages.filter(
      (m) => m.to === id && isOwed(m) && !owedBranches.some((b) => b.id === m.from),
    ),
    owed: owedBranches,
    delivering: messages.filter((m) => m.from === id && m.state === 'sent'),
  }
}

export function messageStatus(message: Message) {
  if (message.state === 'failed') return 'failed'
  if (message.state === 'stopped') return 'stopped'
  if (message.state === 'answered') return 'answered'
  if (message.state === 'dismissed') return 'dismissed'
  if (isOpen(message)) return message.to === 'user' ? 'yours' : 'waiting'
  if (message.state === 'sent') return 'sending'
  return message.re === undefined ? 'one-way' : 'reply'
}

export const sentStatus = (message: Message | undefined, running: boolean) =>
  message ? messageStatus(message) : running ? 'sending' : undefined

export function outgoingState(message: Message | undefined, toUser: boolean, running: boolean) {
  if (!message) return running ? 'sending' : undefined
  if (message.state === 'failed') return 'failed'
  if (message.state === 'stopped') return 'stopped by the user'
  if (message.state === 'answered') return 'answered'
  if (message.state === 'dismissed') return 'dismissed'
  if (message.state === 'sent') return 'sending'
  if (!message.reply) return 'delivered'
  return toUser ? 'awaiting your reply' : 'awaiting reply'
}

export type Place = 'above' | 'visible' | 'below'

export type Pointer<T> = { count: number; nearest: T }

export function offscreen<T>(questionsInTranscriptOrder: readonly { key: T; place: Place }[]) {
  const above = questionsInTranscriptOrder.filter((q) => q.place === 'above')
  const below = questionsInTranscriptOrder.filter((q) => q.place === 'below')
  return {
    up: above.length ? { count: above.length, nearest: above.at(-1)!.key } : undefined,
    down: below.length ? { count: below.length, nearest: below[0].key } : undefined,
  } satisfies Record<'up' | 'down', Pointer<T> | undefined>
}
