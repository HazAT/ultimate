import { defineWebExtension, island } from '@/sdk'
import { MessageUsage } from './message-usage.solid.tsx'
import { Connection, Context, Cwd, GlobalUsage, Tokens } from './status.solid.tsx'

export default defineWebExtension({
  messageDetails: [island(MessageUsage)],
  slots: {
    'composer.status': [island(Cwd), island(Tokens), island(Context)],
    'statusline.left': [island(GlobalUsage)],
    'statusline.right': [{ component: island(Connection), phone: true }],
  },
})
