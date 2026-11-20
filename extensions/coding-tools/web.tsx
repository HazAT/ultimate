import { defineWebExtension, island } from '@/sdk'
import { Bash, BashLine } from './bash.solid.tsx'
import { Edit, EditLine, Read, ReadLine, Write, WriteLine } from './files.solid.tsx'

export default defineWebExtension({
  tools: { read: island(Read), write: island(Write), edit: island(Edit), bash: island(Bash) },
  toolLines: {
    read: island(ReadLine),
    write: island(WriteLine),
    edit: island(EditLine),
    bash: island(BashLine),
  },
})
