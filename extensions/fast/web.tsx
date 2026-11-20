import { defineWebExtension, island } from '@/sdk'
import { FastToggle } from './toggle.solid.tsx'

export default defineWebExtension({
  slots: { 'composer.toolbar': { component: island(FastToggle), order: 1 } },
})
