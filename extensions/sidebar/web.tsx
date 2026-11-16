import { defineWebExtension } from '@/sdk'
import { Conversations, Seen } from './sidebar.tsx'
import { UltimateButton, UltimateWordmark } from './ultimate.tsx'

export default defineWebExtension({
  slots: {
    sidebar: Conversations,
    'titlebar.brand': [UltimateWordmark],
    'titlebar.left': [{ component: UltimateButton, order: 100 }],
    overlay: [Seen],
  },
})
