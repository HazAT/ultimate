import { defineWebExtension, island } from '@/sdk'
import { Chip } from './chip.solid.tsx'

const ModelOnlySetupChangeNote = () => null

export default defineWebExtension({
  slots: { 'statusline.right': [{ component: island(Chip), phone: true }] },
  entries: { 'setup.note': ModelOnlySetupChangeNote },
})
