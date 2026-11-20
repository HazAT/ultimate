import { defineWebExtension, island } from '@/sdk'
import { OpeningBar, Rail } from './rail.solid.tsx'

export default defineWebExtension({
  slots: { 'shell.rail': island(Rail), overlay: island(OpeningBar) },
})
