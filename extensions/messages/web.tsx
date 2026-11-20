import type { EntryRecord } from '@earendil-works/pi-durable'
import { attention, ConversationKind, defineWebExtension, island, provide } from '@/sdk'
import { CompactAnswer, MessageAnswerLabel, HiddenEntry } from './compact-answer.solid.tsx'
import { scriptMessaged, threadRow, ultimateCompact } from './data.ts'
import { MessageInput } from './message-input.solid.tsx'
import { StretchSummary } from './stretch-summary.solid.tsx'
import { BranchCall, MessageCall } from './tool-cards.solid.tsx'
import { MessageNavigation } from './navigation.solid.tsx'
import { OpenMessages } from './open.solid.tsx'
import { QuestionPointer } from './pointer.solid.tsx'
import { OffscreenQuestions } from './waiting.solid.tsx'
import { StandingDoc } from '../subagents/ui.tsx'
import type { MessagesData } from './refs.ts'

const afterPinnedPromptOrder = 1
const input = island(MessageInput)
const hidden = island<{ entry: EntryRecord }>(HiddenEntry)

export default defineWebExtension({
  slots: {
    overlay: [island(MessageNavigation)],
    'composer.status': [island(OpenMessages)],
    'transcript.top': [{ component: island(OffscreenQuestions), order: afterPinnedPromptOrder }],
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
