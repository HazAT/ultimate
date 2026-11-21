import { defineWebExtension, island, provide } from '@/sdk'
import { uiState } from '@/sdk/client'
import { SystemTab, SYSTEM_TAB_KEY } from '../system/ui.tsx'
import { showWire, WireLink } from './link.solid.tsx'
import { Wire } from './surface.solid.tsx'

const tab = { id: 'wire', title: 'Wire', component: island(Wire) }

export default defineWebExtension({
  provides: [provide(SystemTab, () => tab)],
  commands: [
    {
      id: 'wire.open',
      title: 'Open Wire',
      run: (context) => showWire((id) => uiState.set(SYSTEM_TAB_KEY, id), context.showSurface),
    },
  ],
  entries: { 'pi.assistant': island(WireLink) },
})
