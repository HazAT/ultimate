import { defineWebExtension, events } from '@/sdk/solid'
import { Chip } from './chip.solid.tsx'

export default defineWebExtension({
  slots: { 'statusline.right': [{ component: Chip, order: -0.5 }] },
  commands: [
    {
      id: 'headscale.panel',
      title: 'Headscale…',
      run: () => events.emit('headscale:open', undefined),
    },
  ],
})
