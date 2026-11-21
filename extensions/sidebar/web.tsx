import { defineWebExtension, island } from '@/sdk'
import { Conversations, Seen } from './sidebar.solid.tsx'
import { UltimateButton, UltimateWordmark } from './ultimate.solid.tsx'

export default defineWebExtension({
  slots: {
    sidebar: island(Conversations),
    'titlebar.brand': [island(UltimateWordmark)],
    'titlebar.left': [{ component: island(UltimateButton), order: 100 }],
    overlay: [island(Seen)],
  },
})
