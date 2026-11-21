/** @jsxImportSource @solidjs/web */
import { defineWebExtension } from '@/sdk/solid'
import { MessageUsage } from './message-usage.solid.tsx'
import { Connection, Context, Cwd, GlobalUsage, Tokens } from './status.solid.tsx'

export default defineWebExtension({
  messageDetails: [MessageUsage],
  slots: {
    'composer.status': [Cwd, Tokens, Context],
    'statusline.left': [GlobalUsage],
    'statusline.right': [{ component: Connection, phone: true }],
  },
})
