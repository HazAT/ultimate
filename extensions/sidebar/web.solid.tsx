/** @jsxImportSource @solidjs/web */
import { defineWebExtension } from '@/sdk/solid'
import { Conversations, Seen } from './sidebar.solid.tsx'
import { UltimateButton, UltimateWordmark } from './ultimate.solid.tsx'

export default defineWebExtension({
  slots: {
    sidebar: Conversations,
    'titlebar.brand': [UltimateWordmark],
    'titlebar.left': [{ component: UltimateButton, order: 100 }],
    overlay: [Seen],
  },
})
