import { defineWebExtension, island } from '@/sdk'
import { Chip } from './chip.solid.tsx'
import { ModelOnlySetupChangeNote } from './note.solid.tsx'

export default defineWebExtension({
  slots: { 'statusline.right': [{ component: island(Chip), phone: true }] },
  entries: { 'setup.note': island(ModelOnlySetupChangeNote) },
})
