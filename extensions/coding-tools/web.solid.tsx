import { defineWebExtension } from '@/sdk/solid'
import { BackgroundEnded } from './background.solid.tsx'
import { Bash, BashLine } from './bash.solid.tsx'
import { Edit, EditLine, Read, ReadLine, Write, WriteLine } from './files.solid.tsx'

export default defineWebExtension({
  entries: { 'coding-tools.background-ended': BackgroundEnded },
  tools: { read: Read, write: Write, edit: Edit, bash: Bash },
  toolLines: {
    read: ReadLine,
    write: WriteLine,
    edit: EditLine,
    bash: BashLine,
  },
})
