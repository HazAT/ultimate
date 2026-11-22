import { OrbitIcon } from '@lucide/solid'
import { defineWebExtension } from '@/sdk/solid'
import { AntigravityPanel } from './panel.solid.tsx'

export default defineWebExtension({
  panels: [
    {
      id: 'antigravity',
      title: 'Antigravity',
      icon: OrbitIcon,
      component: AntigravityPanel,
      order: 11,
      tab: false,
    },
  ],
  commands: [
    {
      id: 'antigravity.panel',
      title: 'Antigravity setup…',
      run: (context) => context.openPanel('antigravity'),
    },
  ],
})
