import { defineWebExtension } from '@/sdk/solid'
import { Bell, Pusher } from './notifications.solid.tsx'

export default defineWebExtension({
  slots: {
    overlay: [Pusher],
    'statusline.right': [{ component: Bell, order: -1 }],
  },
})
