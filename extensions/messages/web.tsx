import { parseConversationId } from '../../lib/ids.ts'
import type { EntryRecord, ConversationId } from '@earendil-works/pi-durable'
import { ROOT } from '@/sdk'
import { useEffect, useState } from 'react'
import {
  api,
  attention,
  ConversationKind,
  defineWebExtension,
  events,
  provide,
  useConversation,
  useDocOf,
  useEvent,
  useReady,
  useUltimate,
} from '@/sdk'
import {
  Address,
  MessageInput,
  BranchCall,
  CompactAnswer,
  MessageCall,
  StretchSummary,
} from './cards.tsx'
import {
  answeredMessages,
  emptyMessages,
  openQuestion,
  scriptMessaged,
  threadRow,
  ultimateCompact,
} from './data.tsx'
import { callerOf } from './caller.ts'
import { OpenMessages } from './open.tsx'
import { QuestionPointer } from './pointer.tsx'
import { OffscreenQuestions } from './waiting.tsx'
import { StandingDoc } from '../subagents/ui.tsx'
import { MessagesDoc, CallerAction } from './refs.ts'
import type { MessagesData } from './refs.ts'

function MessageAnswerLabel({ entry }: { entry: EntryRecord }) {
  const log = useDocOf(ROOT, MessagesDoc) ?? emptyMessages
  const conversation = useConversation((value) => value.id)
  const messages =
    conversation === undefined ? [] : answeredMessages(log.messages, conversation, entry.id)
  return messages.map((message) => (
    <span
      key={message.id}
      className="inline-flex max-w-full min-w-0 flex-wrap items-center gap-1 text-muted-foreground"
    >
      {message.reply ? '↩ sent to' : 'not sent · one-way from'}{' '}
      <Address id={message.from} remote={message.remote} />
    </span>
  ))
}

function MessageNavigation() {
  const { id, entries, loading } = useConversation()
  const { surface, showSurface } = useUltimate()

  const { ready } = useReady()
  const log = useDocOf(ROOT, MessagesDoc)
  const [target, setTarget] = useState<{
    conversation: ConversationId
    entry?: number
    call?: string
    message?: number
  }>()
  useEvent('messages:open', (value) => setTarget(value as NonNullable<typeof target>))

  useEffect(() => {
    const url = new URL(location.href)
    const message = Number(url.searchParams.get('message'))
    const conversation = parseConversationId(Number(url.searchParams.get('conversation')))
    if (!url.searchParams.has('message')) return
    url.searchParams.delete('message')
    history.replaceState(history.state, '', url)
    if (Number.isSafeInteger(message) && Number.isSafeInteger(conversation) && conversation > 0)
      setTarget({ conversation, message })
  }, [])

  useEffect(() => {
    if (target?.message === undefined || !log) return
    const asked = log.messages.find((m) => m.id === target.message)
    if (asked?.call && asked.from === target.conversation && openQuestion(asked)) {
      showSurface('agent')
      setTarget({ conversation: target.conversation, call: asked.call })
    } else setTarget(undefined)
  }, [target, log, showSurface])
  useEffect(() => {
    if (
      !target ||
      target.message !== undefined ||
      !ready ||
      surface !== 'agent' ||
      id !== target.conversation ||
      loading
    )
      return undefined
    const { call } = target

    const toolCallId = call?.split('/')[0]
    const reveal = (entry: number) =>
      events.emit('ultimate:reveal-entry', { conversationId: id, entryId: entry, toolCallId })
    const loaded = target.entry ?? (toolCallId && callerOf(entries, toolCallId)?.id)
    if (loaded) {
      const revealAndClearTargetFrame = requestAnimationFrame(() => {
        setTarget(undefined)
        reveal(loaded)
      })
      return () => cancelAnimationFrame(revealAndClearTargetFrame)
    }
    setTarget(undefined)
    if (call)
      api.action(CallerAction, { conversation: id, call }).then(
        ({ entry }) => entry !== undefined && reveal(entry),
        () => undefined,
      )
    return undefined
  }, [surface, id, entries, loading, target, ready])
  return null
}

const afterPinnedPromptOrder = 1

export default defineWebExtension({
  slots: {
    overlay: [MessageNavigation],
    'composer.status': [OpenMessages],

    'transcript.top': [{ component: OffscreenQuestions, order: afterPinnedPromptOrder }],
  },
  entries: {
    'board.message': MessageInput,
    'board.reply': MessageInput,
    'board.asked': attention(QuestionPointer),
    'board.answered': () => null,

    'board.wake': () => null,

    'board.open': () => null,
    'pi.assistant': CompactAnswer,
  },
  tools: { message: MessageCall, branch: BranchCall },
  compact: {
    when: (conversation, docs) => ultimateCompact(conversation, docs[StandingDoc.kind]),
    tools: [
      'message',
      'branch',
      'workspace',

      (call, docs) => scriptMessaged(call, docs.board as MessagesData | null | undefined),
    ],
    docs: ['board', StandingDoc.kind],
    thread: (row, docs) => threadRow(row, docs.board as MessagesData | null | undefined),
    summary: StretchSummary,
  },
  answerLabels: [MessageAnswerLabel],
  provides: [
    provide(ConversationKind, (conversation) =>
      conversation?.label === 'coordinator' ? 'branch · coordinator' : undefined,
    ),
  ],
})
