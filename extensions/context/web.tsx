import { defineWebExtension, island } from '@/sdk'
import { CacheRebuilt } from './cache-rebuilt.solid.tsx'
import { ContextStart, Start, SystemEntry } from './entries.solid.tsx'
import { PinnedPrompt } from './pinned.solid.tsx'

export default defineWebExtension({
  slots: { 'transcript.start': [island(Start)], 'transcript.top': [island(PinnedPrompt)] },
  entries: {
    'pi.system': island(SystemEntry),
    'pi.reset': island(ContextStart),
    'pi.compaction': island(ContextStart),
    'pi.assistant': island(CacheRebuilt),
  },
})
