import { defineWebExtension, island } from '@/sdk'
import { RecallBubble } from './bubble.solid.tsx'
import { ModelOnlyRecalledMemories } from './note.solid.tsx'
import { RecalledEntry } from './types.ts'

export default defineWebExtension({
  userBubble: [island(RecallBubble)],
  entries: { [RecalledEntry.kind]: island(ModelOnlyRecalledMemories) },
})
