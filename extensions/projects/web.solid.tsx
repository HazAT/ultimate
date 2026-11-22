import { defineWebExtension } from '@/sdk/solid'
import { OpeningBar, Rail } from './rail.solid.tsx'

export default defineWebExtension({
  slots: { 'shell.rail': Rail, overlay: OpeningBar },
})
