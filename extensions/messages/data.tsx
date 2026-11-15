import { parseConversationId } from '../../lib/ids.ts'
import type { EntryRecord, ConversationId } from '@earendil-works/pi-durable'
import { isOpen, isOwed, openQuestion } from '../../lib/message-state.ts'
import type { MessagesData, Message, Remote } from './refs.ts'
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

export function conversationState(
  conversation: {
    id: number
    kind: 'primary' | 'subagent' | 'other'
    runState?: 'working' | 'queued' | 'idle' | 'answered' | 'error'
    busy?: boolean
    parked?: boolean
    primary?: number
    concludedSince?: number
  },
  log: MessagesData,
): ConversationState {
  const { id, kind, runState } = conversation
  if (conversation.parked) return 'paused'
  const userActionTakesPriority =
    kind === 'primary'
      ? waitingOnUser(log) > 0
      : kind === 'other' && log.messages.some((m) => m.from === id && openQuestion(m))
  if (userActionTakesPriority) return 'waits'
  if (conversation.busy || runState === 'working' || runState === 'queued') return 'working'
  if (
    kind !== 'subagent' &&
    awaitsPrimary(id, conversation.primary, log, () => conversation.concludedSince)
  )
    return 'awaiting'
  if (runState === 'error') return 'failed'
  if (kind === 'subagent' && runState === 'answered') return 'done'
  return 'idle'
}

function awaitsPrimary(
  id: number,
  primary: number | undefined,
  log: MessagesData,
  concludedSince: (id: ConversationId) => number | undefined,
) {
  if (primary === undefined) return false
  return (
    log.messages.some((m) => m.from === id && m.to === primary && isOpen(m)) ||
    pendingReport(log.messages, id, primary, concludedSince) !== undefined
  )
}

export function pendingReport(
  messages: readonly Message[],
  from: number | 'user' | 'remote',
  to: number | 'user' | 'remote',
  concludedSince: (id: ConversationId) => number | undefined,
) {
  let pending: Message | undefined
  for (const m of messages)
    if (m.from === from && m.to === to) {
      if ((m.report || m.awaits) && !settled(m, concludedSince)) pending = m
    } else if (m.from === to && m.to === from) pending = undefined
  return pending
}

export function stateWord(state: ConversationState, waiting = 0) {
  if (state === 'waits') return waiting > 0 ? `${waiting} waiting on you` : 'waits on you'
  return state === 'awaiting' ? 'awaiting @ultimate' : state
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
  concludedSince: (id: ConversationId) => number | undefined,
) {
  const reporters = new Set(
    messages.filter((m) => m.to === id && (m.report || m.awaits)).map((m) => m.from),
  )
  const reports = [...reporters].flatMap(
    (from) => pendingReport(messages, from, id, concludedSince) ?? [],
  )
  return {
    waiting: messages.filter((m) => m.from === id && isOwed(m)),
    owed: [...messages.filter((m) => m.to === id && isOwed(m)), ...reports].toSorted(
      (a, b) => a.id - b.id,
    ),
    delivering: messages.filter((m) => m.from === id && m.state === 'sent'),
  }
}

export const settled = (
  message: Message,
  concludedSince: (id: ConversationId) => number | undefined,
) => typeof message.from === 'number' && message.at <= (concludedSince(message.from) ?? -Infinity)

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
