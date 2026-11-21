/** @jsxImportSource @solidjs/web */
import { defineWebExtension } from '@/sdk/solid'
import { Bash, BashLine } from './bash.solid.tsx'
import { Edit, EditLine, Read, ReadLine, Write, WriteLine } from './files.solid.tsx'

export default defineWebExtension({
  tools: { read: Read, write: Write, edit: Edit, bash: Bash },
  toolLines: {
    read: ReadLine,
    write: WriteLine,
    edit: EditLine,
    bash: BashLine,
  },
})
