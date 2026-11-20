import { OrbitIcon } from 'lucide-react'
import { defineWebExtension, island } from '@/sdk'
import { AntigravityPanel } from './panel.solid.tsx'

export default defineWebExtension({
  panels: [
    {
      id: 'antigravity',
      title: 'Antigravity',
      icon: OrbitIcon,
      component: island(AntigravityPanel),
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
