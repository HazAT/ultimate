import { defineWebExtension, UserTurn } from '@/sdk/solid'
import { Chip } from './chip.solid.tsx'

export default defineWebExtension({
  slots: { 'statusline.right': [{ component: Chip, order: -2 }] },
  entries: { 'update.merge': UserTurn },
})
