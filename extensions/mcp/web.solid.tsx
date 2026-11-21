/** @jsxImportSource @solidjs/web */
import { defineWebExtension, provide } from '@/sdk/solid'
import { ExtensionDetails } from '../onboarding/ui.solid.tsx'
import { Chip, Details } from './chip.solid.tsx'

export default defineWebExtension({
  slots: { 'statusline.right': [{ component: Chip, order: -2 }] },
  provides: [provide(ExtensionDetails, Details)],
})
