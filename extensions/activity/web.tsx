import { ActivityIcon } from 'lucide-react'
import { defineWebExtension, island } from '@/sdk'
import { ActivityPanel } from './panel.solid.tsx'

export default defineWebExtension({
  panels: [
    {
      id: 'activity',
      title: 'Activity',
      icon: ActivityIcon,
      component: island(ActivityPanel),
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
