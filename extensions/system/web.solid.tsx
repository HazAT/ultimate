/** @jsxImportSource @solidjs/web */
import { GanttChartIcon } from '@lucide/solid'
import { defineWebExtension } from '@/sdk/solid'
import { NavigationReporter } from './navigation.solid.tsx'
import { System } from './surface.solid.tsx'

export default defineWebExtension({
  surfaces: [
    {
      id: 'system',
      title: 'System',
      icon: GanttChartIcon,
      description: 'What every agent is doing, and everything recorded, live',
      order: 50,
      component: System,
    },
  ],
  commands: [
    { id: 'system.open', title: 'Open System', run: (context) => context.showSurface('system') },
  ],
  slots: { overlay: [NavigationReporter] },
})
