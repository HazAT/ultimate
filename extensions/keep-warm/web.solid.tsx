import { defineWebExtension } from '@/sdk/solid'
import { BranchChip, UltimateChip } from './chip.solid.tsx'

export default defineWebExtension({
  slots: {
    'statusline.right': [
      { component: BranchChip, order: -2 },
      { component: UltimateChip, order: -1 },
    ],
  },
})
