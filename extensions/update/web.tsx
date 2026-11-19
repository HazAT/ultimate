import { defineWebExtension, island } from '@/sdk'
import { Chip } from './chip.solid.tsx'

export default defineWebExtension({
  slots: { 'statusline.right': [{ component: island(Chip), order: -2 }] },
})
