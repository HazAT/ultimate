import { defineWebExtension } from '@/sdk/solid'
import { Chip } from './chip.solid.tsx'
import { ModelOnlySetupChangeNote } from './note.solid.tsx'

export default defineWebExtension({
  slots: { 'statusline.right': [{ component: Chip, phone: true }] },
  entries: { 'setup.note': ModelOnlySetupChangeNote },
})
