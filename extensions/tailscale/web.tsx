import { defineWebExtension, events, island } from '@/sdk'
import { Chip } from './chip.solid.tsx'

export default defineWebExtension({
  slots: { 'statusline.right': [{ component: island(Chip), order: -0.5 }] },
  commands: [
    {
      id: 'tailscale.panel',
      title: 'Tailscale…',
      run: () => events.emit('tailscale:open', undefined),
    },
  ],
})
