import { defineWebExtension } from '@/sdk/solid'
import { JoinDialog, joinDialog } from './join.solid.tsx'
import { CloudStatus } from './status.solid.tsx'

export default defineWebExtension({
  slots: { 'statusline.right': [CloudStatus], overlay: [JoinDialog] },
  commands: [
    { id: joinDialog, title: 'Join cloud backups', run: (context) => context.open(joinDialog) },
  ],
})
