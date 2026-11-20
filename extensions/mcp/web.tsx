import { defineWebExtension, island, provide } from '@/sdk'
import { ExtensionDetails } from '../onboarding/ui.tsx'
import { Chip, Details } from './chip.solid.tsx'

export default defineWebExtension({
  slots: { 'statusline.right': [{ component: island(Chip), order: -2 }] },
  provides: [provide(ExtensionDetails, island(Details))],
})
