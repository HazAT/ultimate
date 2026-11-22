import { defineWebExtension } from '@/sdk/solid'
import { VoiceButton } from './button.solid.tsx'

export default defineWebExtension({ slots: { 'composer.actions': [VoiceButton] } })
