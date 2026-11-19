import { defineWebExtension, island } from '@/sdk'
import { Bell, Pusher } from './notifications.solid.tsx'

export default defineWebExtension({
  slots: {
    overlay: [island(Pusher)],
    'statusline.right': [{ component: island(Bell), order: -1 }],
  },
})
