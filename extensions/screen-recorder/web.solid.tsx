import { defineWebExtension, PromptRecorder, provide } from '@/sdk/solid'
import { RecordButton } from './button.solid.tsx'

export default defineWebExtension({
  provides: [provide(PromptRecorder, RecordButton)],
})
