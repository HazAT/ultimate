import { defineWebExtension, events } from '@/sdk/solid'
import { Chip } from './chip.solid.tsx'

export default defineWebExtension({
  slots: { 'statusline.right': [{ component: Chip, order: -0.5 }] },
  commands: [
    {
      id: 'tailscale.panel',
      title: 'Tailscale…',
      run: () => events.emit('tailscale:open', undefined),
    },
  ],
})
