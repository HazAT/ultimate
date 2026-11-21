import { defineWebExtension, island, provide } from '@/sdk'
import { SystemTab } from '../system/ui.tsx'
import { WireLink } from './link.solid.tsx'
import { OpenOnCommand, Wire, openDialog } from './surface.solid.tsx'

const tab = { id: 'wire', title: 'Wire', component: island(Wire) }

export default defineWebExtension({
  provides: [provide(SystemTab, () => tab)],
  commands: [{ id: 'wire.open', title: 'Open Wire', run: (context) => context.open(openDialog) }],
  slots: { overlay: [island(OpenOnCommand)] },
  entries: { 'pi.assistant': island(WireLink) },
})
