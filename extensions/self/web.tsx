import { defineWebExtension, island } from '@/sdk'
import { RestartCall } from './restart.solid.tsx'
import { Build, CoreStale, Rebuild } from './status.solid.tsx'
import { Updated } from './updated.solid.tsx'

export default defineWebExtension({
  tools: { restart: island(RestartCall) },
  slots: {
    'statusline.right': [
      { component: island(CoreStale), phone: true },
      { component: island(Rebuild), order: 1, phone: true },
      { component: island(Build), order: 1 },
    ],
    overlay: island(Updated),
  },
})
