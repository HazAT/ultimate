import { defineWebExtension, island } from '@/sdk'
import { JoinDialog, joinDialog } from './join.solid.tsx'
import { CloudStatus } from './status.solid.tsx'

export default defineWebExtension({
  slots: { 'statusline.right': [island(CloudStatus)], overlay: [island(JoinDialog)] },
  commands: [
    { id: joinDialog, title: 'Join cloud backups', run: (context) => context.open(joinDialog) },
  ],
})
