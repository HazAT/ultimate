import { defineWebExtension } from '@/sdk/solid'
import { RestartCall } from './restart.solid.tsx'
import { Build, CoreStale, Rebuild } from './status.solid.tsx'
import { Updated } from './updated.solid.tsx'

export default defineWebExtension({
  tools: { restart: RestartCall },
  slots: {
    'statusline.right': [
      { component: CoreStale, phone: true },
      { component: Rebuild, order: 1, phone: true },
      { component: Build, order: 1 },
    ],
    overlay: Updated,
  },
})
