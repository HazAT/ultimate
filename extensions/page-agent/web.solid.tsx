import { defineWebExtension } from '@/sdk/solid'
import { PageAgentRunner } from './runner.solid.tsx'

export default defineWebExtension({
  slots: { overlay: PageAgentRunner },
})
