import { defineWebExtension } from '@/sdk/solid'
import { CacheRebuilt } from './cache-rebuilt.solid.tsx'
import { ContextStart, Start, SystemEntry } from './entries.solid.tsx'
import { PinnedPrompt } from './pinned.solid.tsx'

export default defineWebExtension({
  slots: { 'transcript.start': [Start], 'transcript.top': [PinnedPrompt] },
  entries: {
    'pi.system': SystemEntry,
    'pi.reset': ContextStart,
    'pi.compaction': ContextStart,
    'pi.assistant': CacheRebuilt,
  },
})
