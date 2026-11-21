import { InboxIcon } from 'lucide-react'
import { defineWebExtension, island, provide } from '@/sdk'
import { UnderUltimate } from '../sidebar/ui.tsx'
import { SURFACE } from './items.ts'
import { Inbox, InboxSidebar, WaitingBadge, WaitingLink } from './surface.solid.tsx'

export default defineWebExtension({
  slots: { overlay: [island(WaitingLink)] },
  surfaces: [
    {
      id: SURFACE,
      title: 'Inbox',
      icon: InboxIcon,
      description: 'Everything that waits on you, oldest first, answered in place',
      order: 10,
      component: island(Inbox),
      badge: island(WaitingBadge),
    },
  ],
  commands: [
    {
      id: 'inbox.open',
      title: 'Open Inbox',
      run: (context) => context.showSurface(SURFACE),
    },
  ],
  provides: [provide(UnderUltimate, island(InboxSidebar))],
})
