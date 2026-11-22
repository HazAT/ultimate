import { ActivityIcon } from '@lucide/solid'
import { defineWebExtension } from '@/sdk/solid'
import { ActivityPanel } from './panel.solid.tsx'

export default defineWebExtension({
  panels: [
    {
      id: 'activity',
      title: 'Activity',
      icon: ActivityIcon,
      component: ActivityPanel,
      order: 2,
    },
  ],
  commands: [
    {
      id: 'activity.open',
      title: 'Show recent activity',
      run: (context) => context.openPanel('activity'),
    },
  ],
})
