import { defineWebExtension, Dictation, provide } from '@/sdk/solid'
import { VoiceButton } from './button.solid.tsx'

export default defineWebExtension({
  provides: [provide(Dictation, VoiceButton)],
})
