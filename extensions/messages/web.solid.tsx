/** @jsxImportSource @solidjs/web */
import { attention, ConversationKind, defineWebExtension, provide } from '@/sdk/solid'
import { CompactAnswer, MessageAnswerLabel, HiddenEntry } from './compact-answer.solid.tsx'
import { scriptMessaged, threadRow, ultimateCompact } from './data.ts'
import { MessageInput } from './message-input.solid.tsx'
import { StretchSummary } from './stretch-summary.solid.tsx'
import { BranchCall, MessageCall } from './tool-cards.solid.tsx'
import { MessageNavigation } from './navigation.solid.tsx'
import { OpenMessages } from './open.solid.tsx'
import { QuestionPointer } from './pointer.solid.tsx'
import { OffscreenQuestions } from './waiting.solid.tsx'
import { StandingDoc } from '../subagents/refs.ts'
import type { MessagesData } from './refs.ts'

const afterPinnedPromptOrder = 1
const input = MessageInput
const hidden = HiddenEntry

export default defineWebExtension({
  slots: {
    overlay: [MessageNavigation],
    'composer.status': [OpenMessages],
    'transcript.top': [{ component: OffscreenQuestions, order: afterPinnedPromptOrder }],
  },
  entries: {
    'board.message': input,
    'board.reply': input,
    'board.asked': attention(QuestionPointer),
    'board.answered': hidden,
    'board.wake': hidden,
    'board.open': hidden,
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
    provide(
      ConversationKind,
      (conversation) => () =>
        conversation()?.label === 'coordinator' ? 'branch · coordinator' : undefined,
    ),
  ],
})
