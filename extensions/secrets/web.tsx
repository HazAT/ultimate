import { KeyRoundIcon } from 'lucide-react'
import { defineWebExtension, island } from '@/sdk'
import { Opener, SecretsPanel } from './panel.solid.tsx'

export default defineWebExtension({
  slots: { overlay: [island(Opener)] },
  panels: [
    {
      id: 'secrets',
      title: 'Secrets',
      icon: KeyRoundIcon,
      component: island(SecretsPanel),
      order: 9,
      tab: false,
    },
  ],
  commands: [
    {
      id: 'secrets.panel',
      title: 'Secrets…',
      run: (context) => context.openPanel('secrets'),
    },
  ],
})
