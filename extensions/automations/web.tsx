import { TimerIcon } from 'lucide-react'
import { defineWebExtension, island, provide, ROOT, useDocOf, useStore, useViewport } from '@/sdk'
import { WaitTimers } from '../messages/ui.tsx'
import { StandingDoc } from '../subagents/ui.tsx'
import { AutomationCall } from './call.solid.tsx'
import { Chip } from './chip.solid.tsx'
import { Escalated, Failed, Fired, Writing } from './entry.solid.tsx'
import { openAutomationsPanel } from './navigation.ts'
import { AutomationsPanel } from './panel.solid.tsx'
import { AutomationsSection } from './sidebar.solid.tsx'
import { useAutomations, timerWaits } from './ui.tsx'

const PanelIsland = island(AutomationsPanel)

function Panel() {
  const viewport = useViewport()
  const overlayOpen = useStore(
    (state) => viewport !== 'desktop' && (state.ui.open?.[viewport]?.panels ?? false),
  )
  const requested = useStore((state) => state.requested)
  return <PanelIsland overlayOpen={overlayOpen} requested={requested} />
}

function useWaitTimers() {
  return timerWaits(useAutomations(5000).data, useDocOf(ROOT, StandingDoc))
}

export default defineWebExtension({
  provides: [provide(WaitTimers, useWaitTimers)],
  tools: { automation: island(AutomationCall) },
  slots: {
    'statusline.right': [{ component: island(Chip), order: -2 }],
    'sidebar.top': [{ component: island(AutomationsSection), order: -20 }],
  },
  entries: {
    'automations.fired': island(Fired),
    'automations.failed': island(Failed),
    'automations.escalated': island(Escalated),
    'automations.writing': island(Writing),
  },
  panels: [
    {
      id: 'automations',
      title: 'Automations',
      icon: TimerIcon,
      component: Panel,
      order: 2.5,
    },
  ],
  commands: [
    {
      id: 'automations.open',
      title: 'Automations…',
      run: openAutomationsPanel,
    },
  ],
})
