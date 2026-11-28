import { GitFork } from '@lucide/solid'
import { defineWebExtension, EmptyTranscript, provide, renderEntry, writingAs } from '@/sdk/solid'
import {
  LegacySummaryEntry,
  LegacyVoiceHandoffEntry,
  LegacyVoiceSummaryEntry,
  LegacyVoiceTurnEntry,
  SideChatHandoffEntry,
  SideChatSummaryEntry,
  SideChatTurnEntry,
} from './entries.shared.ts'
import { HandoffCall, HandoffCard, LegacySummaryCard, SummaryCard } from './handoff.solid.tsx'
import { dock, hideSideChat, KEYS, sideChatOpen } from './dock.solid.tsx'
import { SideComposer } from './frame.solid.tsx'
import { openSideChat, PANEL, SideChatPanel, SideChatOverlay } from './panel.solid.tsx'
import { ForkStart, inboxSideChat, TalkItThrough } from './question.solid.tsx'
import { SideChatRow, sideChatForks } from './row.solid.tsx'
import { inboxChat } from './side.solid.tsx'
import { QuestionPane } from '../inbox/ui.solid.tsx'
import { CardActions } from '../questions/ui.solid.tsx'
import { UnderUltimate, Unlisted } from '../sidebar/ui.solid.tsx'
import { PendingTurns, StoredTurn } from './turns.solid.tsx'

export default defineWebExtension({
  slots: {
    overlay: [SideChatOverlay],
    'transcript.end': [PendingTurns],
  },
  panels: [
    {
      id: PANEL,
      title: 'Side chat',
      icon: GitFork,
      component: SideChatPanel,
      tab: false,
    },
  ],
  composer: SideComposer,
  entries: {
    [SideChatHandoffEntry.kind]: renderEntry(SideChatHandoffEntry, HandoffCard),
    [SideChatSummaryEntry.kind]: renderEntry(SideChatSummaryEntry, SummaryCard),
    [SideChatTurnEntry.kind]: renderEntry(SideChatTurnEntry, StoredTurn),
    [LegacyVoiceHandoffEntry.kind]: renderEntry(LegacyVoiceHandoffEntry, HandoffCard),
    [LegacyVoiceSummaryEntry.kind]: renderEntry(LegacyVoiceSummaryEntry, SummaryCard),
    [LegacyVoiceTurnEntry.kind]: renderEntry(LegacyVoiceTurnEntry, StoredTurn),
    [LegacySummaryEntry.kind]: renderEntry(LegacySummaryEntry, LegacySummaryCard),
  },
  provides: [
    provide(UnderUltimate, SideChatRow),
    provide(Unlisted, sideChatForks),
    provide(CardActions, TalkItThrough),
    provide(QuestionPane, inboxSideChat),
    provide(EmptyTranscript, ForkStart),
  ],
  tools: { side_chat_handoff: HandoffCall },
  commands: [
    {
      id: 'side-chat.toggle',
      title: 'Side chat: open or hide',
      keys: KEYS,
      run: () => {
        const embedded = inboxChat()
        if (embedded) embedded.park()
        if (embedded || sideChatOpen()) return hideSideChat()
        writingAs('app', () => dock.setSideMode(false))
        openSideChat()
      },
    },
  ],
})
