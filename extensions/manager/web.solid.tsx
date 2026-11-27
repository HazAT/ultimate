import { BlocksIcon } from '@lucide/solid'
import { defineWebExtension } from '@/sdk/solid'
import { ExtensionsPanel } from './panel.solid.tsx'

export default defineWebExtension({
  panels: [
    {
      id: 'extensions',
      title: 'Extensions',
      icon: BlocksIcon,
      component: ExtensionsPanel,
      order: 8,
    },
  ],
  commands: [
    {
      id: 'manager.open',
      title: 'Extensions…',
      run: (context) => context.openPanel('extensions'),
    },
  ],
})
