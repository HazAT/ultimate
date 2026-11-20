import { parseConversationId } from '../../lib/ids.ts'
import type { ConversationId, EntryRecord } from '@earendil-works/pi-durable'
import { ROOT } from '@/sdk'
import { useEffect, useState } from 'react'
import {
  api,
  attention,
  ConversationKind,
  defineWebExtension,
  events,
  island,
  provide,
  useConversation,
  useDocOf,
  useEvent,
  useReady,
  useUltimate,
} from '@/sdk'
import { CompactAnswer, MessageAnswerLabel, HiddenEntry } from './compact-answer.solid.tsx'
import { openQuestion, scriptMessaged, threadRow, ultimateCompact } from './data.ts'
import { MessageInput } from './message-input.solid.tsx'
import { StretchSummary } from './stretch-summary.solid.tsx'
import { BranchCall, MessageCall } from './tool-cards.solid.tsx'
import { callerOf } from './caller.ts'
import { OpenMessages } from './open.tsx'
import { QuestionPointer } from './pointer.solid.tsx'
import { OffscreenQuestions } from './waiting.tsx'
import { StandingDoc } from '../subagents/ui.tsx'
import { MessagesDoc, CallerAction } from './refs.ts'
import type { MessagesData } from './refs.ts'

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
const input = island(MessageInput)
const hidden = island<{ entry: EntryRecord }>(HiddenEntry)

export default defineWebExtension({
  slots: {
    overlay: [MessageNavigation],
    'composer.status': [OpenMessages],

    'transcript.top': [{ component: OffscreenQuestions, order: afterPinnedPromptOrder }],
  },
  entries: {
    'board.message': input,
    'board.reply': input,
    'board.asked': attention(island(QuestionPointer)),
    'board.answered': hidden,
    'board.wake': hidden,
    'board.open': hidden,
    'pi.assistant': island(CompactAnswer),
  },
  tools: { message: island(MessageCall), branch: island(BranchCall) },
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
    summary: island(StretchSummary),
  },
  answerLabels: [island(MessageAnswerLabel)],
  provides: [
    provide(ConversationKind, (conversation) =>
      conversation?.label === 'coordinator' ? 'branch · coordinator' : undefined,
    ),
  ],
})
