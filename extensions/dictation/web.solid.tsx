import { defineWebExtension, Dictation, provide } from '@/sdk/solid'
import { VoiceButton } from './button.solid.tsx'
import { DictationShortcuts } from './routing.solid.tsx'

export default defineWebExtension({
  slots: { overlay: DictationShortcuts },
  provides: [provide(Dictation, VoiceButton)],
})
