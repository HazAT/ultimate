import { defineWebExtension } from '@/sdk'
import { focusFilter } from './filter-box.tsx'
import { Conversations, Seen } from './sidebar.tsx'
import { UltimateButton, UltimateWordmark } from './ultimate.tsx'

export default defineWebExtension({
  slots: {
    sidebar: Conversations,
    'titlebar.brand': [UltimateWordmark],
    'titlebar.left': [{ component: UltimateButton, order: 100 }],
    overlay: [Seen],
  },
  commands: [
    {
      id: 'sidebar.filter',
      title: 'Find a conversation…',
      group: 'Conversations',
      keys: '/',
      run: (context) => {
        if (document.querySelector('[data-sidebar-filter]')) return focusFilter()
        // A closed sidebar mounts no field: open it, then focus once it rendered.
        context.toggleSidebar()
        requestAnimationFrame(() => requestAnimationFrame(focusFilter))
      },
    },
  ],
})
