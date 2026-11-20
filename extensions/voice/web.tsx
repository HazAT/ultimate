import { defineWebExtension, island } from '@/sdk'
import { VoiceButton } from './button.solid.tsx'

export default defineWebExtension({ slots: { 'composer.actions': [island(VoiceButton)] } })
