import { defineWebExtension, island } from '@/sdk'
import { BranchChip, UltimateChip } from './chip.solid.tsx'

export default defineWebExtension({
  slots: {
    'statusline.right': [
      { component: island(BranchChip), order: -2 },
      { component: island(UltimateChip), order: -1 },
    ],
  },
})
