import { InboxIcon } from '@lucide/solid'
import { defineWebExtension, provide } from '@/sdk/solid'
import { UnderUltimate } from '../sidebar/ui.solid.tsx'
import { SURFACE } from './items.ts'
import { Inbox, InboxSidebar, WaitingBadge, WaitingLink } from './surface.solid.tsx'

export default defineWebExtension({
  slots: { overlay: [WaitingLink] },
  surfaces: [
    {
      id: SURFACE,
      title: 'Inbox',
      icon: InboxIcon,
      description: 'Everything that waits on you, oldest first, answered in place',
      order: 10,
      component: Inbox,
      badge: WaitingBadge,
    },
  ],
  commands: [
    {
      id: 'inbox.open',
      title: 'Open Inbox',
      run: (context) => context.showSurface(SURFACE),
    },
  ],
  provides: [provide(UnderUltimate, InboxSidebar)],
})
