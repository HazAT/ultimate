import { defineWebExtension } from '@/sdk/solid'
import { FastToggle } from './toggle.solid.tsx'

export default defineWebExtension({
  slots: { 'composer.toolbar': { component: FastToggle, order: 1 } },
})
