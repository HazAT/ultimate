import { KeyRoundIcon } from '@lucide/solid'
import { defineWebExtension } from '@/sdk/solid'
import { Opener, SecretsPanel } from './panel.solid.tsx'

export default defineWebExtension({
  slots: { overlay: [Opener] },
  panels: [
    {
      id: 'secrets',
      title: 'Secrets',
      icon: KeyRoundIcon,
      component: SecretsPanel,
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
