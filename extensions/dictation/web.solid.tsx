import { defineWebExtension, Dictation, DictationShortcut, provide } from '@/sdk/solid'
import { VoiceButton } from './button.solid.tsx'
import { DictationShortcuts, shortcutHint } from './routing.solid.tsx'

export default defineWebExtension({
  slots: { overlay: DictationShortcuts },
  provides: [provide(Dictation, VoiceButton), provide(DictationShortcut, () => shortcutHint)],
})
