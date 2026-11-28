import { GitFork } from '@lucide/solid'
import { defineWebExtension, EmptyTranscript, provide, renderEntry, writingAs } from '@/sdk/solid'
import { VoiceTurnEntry } from './entries.shared.ts'
import { HandoffCall, HandoffCard, SummaryCard } from './handoff.solid.tsx'
import { dock, KEYS, setVoiceOpen, voiceOpen } from './dock.solid.tsx'
import { SideComposer } from './frame.solid.tsx'
import { openSideChat, PANEL, SideChatPanel, VoicePanel } from './panel.solid.tsx'
import { ForkStart, inboxSideChat, TalkItThrough } from './question.solid.tsx'
import { VoiceRow, voiceForks } from './row.solid.tsx'
import { QuestionPane } from '../inbox/ui.solid.tsx'
import { CardActions } from '../questions/ui.solid.tsx'
import { UnderUltimate, Unlisted } from '../sidebar/ui.solid.tsx'
import { PendingTurns, StoredTurn } from './turns.solid.tsx'

const TurnRow = renderEntry(VoiceTurnEntry, StoredTurn)

export default defineWebExtension({
  slots: {
    overlay: [VoicePanel],
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
    'voice.handoff': HandoffCard,
    'voice.summary': SummaryCard,
    'voice.turn': TurnRow,
  },
  provides: [
    provide(UnderUltimate, VoiceRow),
    provide(Unlisted, voiceForks),
    provide(CardActions, TalkItThrough),
    provide(QuestionPane, inboxSideChat),
    provide(EmptyTranscript, ForkStart),
  ],
  tools: { voice_handoff: HandoffCall },
  commands: [
    {
      id: 'voice-live.toggle',
      title: 'Side chat: open or hide',
      keys: KEYS,
      run: () => {
        if (voiceOpen()) return setVoiceOpen(false)
        writingAs('app', () => dock.setSideMode(false))
        openSideChat()
      },
    },
  ],
})
