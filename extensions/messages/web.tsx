import type { EntryRecord } from '@earendil-works/pi-durable'
import { useEffect, useState } from 'react'
import {
  api,
  ConversationKind,
  defineWebExtension,
  events,
  provide,
  useConversation,
  useDocOf,
  useEvent,
  useUltimate,
} from '@/sdk'
import {
  Address,
  BackgroundSummary,
  MessageInput,
  BranchCall,
  CompactAnswer,
  MessageCall,
} from './cards.tsx'
import {
  answeredMessages,
  backgroundRow,
  emptyMessages,
  scriptMessaged,
  threadRow,
  ultimateCompact,
} from './data.tsx'
import { callerOf } from './caller.ts'
import { OpenMessages } from './open.tsx'
import { StandingDoc } from '../subagents/ui.tsx'
import { MessagesDoc, CallerAction } from './refs.ts'
import type { MessagesData } from './refs.ts'

function MessageAnswerLabel({ entry }: { entry: EntryRecord }) {
  const log = useDocOf(1, MessagesDoc) ?? emptyMessages
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

/**
 * Stay mounted across surfaces so an Open click can reveal after Agent mounts and loads. `messages:open` names the entry,
 * or the tool call that sent a message (`call`): the response that made it, found in the loaded entries or else in the
 * stored history, which the transcript then pages in.
 */
function MessageNavigation() {
  const { id, entries, loading } = useConversation()
  const { surface } = useUltimate()
  const [target, setTarget] = useState<{ conversation: number; entry?: number; call?: string }>()
  useEvent('messages:open', (value) => setTarget(value as NonNullable<typeof target>))
  useEffect(() => {
    if (!target || surface !== 'agent' || id !== target.conversation || loading) return undefined
    const { call } = target
    const reveal = (entry: number) =>
      events.emit('ultimate:reveal-entry', { conversationId: id, entryId: entry })
    const loaded = target.entry ?? (call && callerOf(entries, call.split('/')[0])?.id)
    setTarget(undefined)
    // Not cancelled: clearing the target re-runs this effect, and after a switch that re-render can come before the frame.
    if (loaded) requestAnimationFrame(() => reveal(loaded))
    else if (call)
      api.action(CallerAction, { conversation: id, call }).then(
        ({ entry }) => entry !== undefined && reveal(entry),
        // The conversation is open either way; only the scroll to the question is lost.
        () => undefined,
      )
    return undefined
  }, [surface, id, entries, loading, target])
  return null
}

export default defineWebExtension({
  slots: { overlay: [MessageNavigation], 'composer.status': [OpenMessages] },
  entries: {
    'board.message': MessageInput,
    'board.reply': MessageInput,
    // Retired: triage's wake-up pointer in older transcripts.
    'board.wake': () => null,
    // The agent's reminder of the questions still open; the user sees them in the To-dos panel.
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
      'setup',
      // A script that messaged you stays visible, so its messages show as bubbles, even when it was interrupted.
      (call, docs) => scriptMessaged(call, docs.board as MessagesData | null | undefined),
    ],
    docs: ['board', StandingDoc.kind],
    // Traffic between agents is background to your conversation with @ultimate: each stretch of it folds into one line.
    quiet: (row, docs) => backgroundRow(row, docs.board as MessagesData | null | undefined),
    summary: BackgroundSummary,
    // Your inputs and @ultimate's messages to you are what you read; everything between recedes.
    thread: (row, docs) => threadRow(row, docs.board as MessagesData | null | undefined),
  },
  answerLabels: [MessageAnswerLabel],
  // The `branch` tool labels the coordinator branches it starts; the title bar names their kind before the agent.
  provides: [
    provide(ConversationKind, (conversation) =>
      conversation?.label === 'coordinator' ? 'branch · coordinator' : undefined,
    ),
  ],
})
