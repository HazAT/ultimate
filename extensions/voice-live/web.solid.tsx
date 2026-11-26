import { defineWebExtension, provide, renderEntry } from '@/sdk/solid'
import { VoiceTurnEntry } from './entries.ts'
import { HandoffCall, HandoffCard } from './handoff.solid.tsx'
import { KEYS, setVoiceOpen, voiceOpen } from './dock.solid.tsx'
import { SheetComposer, VoicePanel, VoiceToggle } from './panel.solid.tsx'
import { VoiceRow, voiceForks } from './row.solid.tsx'
import { UnderUltimate, Unlisted } from '../sidebar/ui.solid.tsx'
import { PendingTurns, StoredTurn } from './turns.solid.tsx'

const TurnRow = renderEntry(VoiceTurnEntry, StoredTurn)

export default defineWebExtension({
  slots: {
    'titlebar.right': [{ component: VoiceToggle, phone: true }],
    overlay: [VoicePanel],
    'transcript.end': [PendingTurns],
  },
  composer: SheetComposer,
  entries: {
    'voice.handoff': HandoffCard,
    'voice.turn': TurnRow,
  },
  provides: [provide(UnderUltimate, VoiceRow), provide(Unlisted, voiceForks)],
  tools: { voice_handoff: HandoffCall },
  commands: [
    {
      id: 'voice-live.toggle',
      title: 'Voice: open or hide',
      keys: KEYS,
      run: () => setVoiceOpen(!voiceOpen()),
    },
  ],
})
