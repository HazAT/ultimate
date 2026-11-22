import { defineWebExtension } from '@/sdk/solid'
import { RecallBubble } from './bubble.solid.tsx'
import { ModelOnlyRecalledMemories } from './note.solid.tsx'
import { RecalledEntry } from './types.ts'

export default defineWebExtension({
  userBubble: [RecallBubble],
  entries: { [RecalledEntry.kind]: ModelOnlyRecalledMemories },
})
