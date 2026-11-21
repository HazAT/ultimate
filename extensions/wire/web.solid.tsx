/** @jsxImportSource @solidjs/web */
import { defineWebExtension, provide, setUiState } from '@/sdk/solid'
import { SystemTab, SYSTEM_TAB_KEY } from '../system/ui.solid.tsx'
import { showWire, WireLink } from './link.solid.tsx'
import { Wire } from './surface.solid.tsx'

const tab = { id: 'wire', title: 'Wire', component: Wire }

export default defineWebExtension({
  provides: [provide(SystemTab, () => () => tab)],
  commands: [
    {
      id: 'wire.open',
      title: 'Open Wire',
      run: (context) => showWire((id) => setUiState(SYSTEM_TAB_KEY, id), context.showSurface),
    },
  ],
  entries: { 'pi.assistant': WireLink },
})
