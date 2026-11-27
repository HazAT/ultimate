import { GanttChartIcon } from '@lucide/solid'
import { defineWebExtension, provide, setUiState } from '@/sdk/solid'
import { NavigationReporter } from './navigation.solid.tsx'
import { Shortcuts } from './shortcuts.solid.tsx'
import { System } from './surface.solid.tsx'
import { SYSTEM_TAB_KEY, SystemTab } from './tab.web.ts'

const shortcuts = { id: 'shortcuts', title: 'Shortcuts', component: Shortcuts }

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
    {
      id: 'system.shortcuts',
      title: 'Keyboard shortcuts',
      run: (context) => {
        setUiState(SYSTEM_TAB_KEY, 'shortcuts')
        context.showSurface('system')
      },
    },
  ],
  provides: [provide(SystemTab, () => () => shortcuts)],
  slots: { overlay: [NavigationReporter] },
})
