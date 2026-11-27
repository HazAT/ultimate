import { TimerIcon } from '@lucide/solid'
import { createMemo } from 'solid-js'
import { defineWebExtension, provide, ROOT, useDocOf } from '@/sdk/solid'
import { WaitTimers } from '../messages/ui.solid.tsx'
import { StandingDoc } from '../subagents/refs.ts'
import { AutomationCall } from './call.solid.tsx'
import { Chip } from './chip.solid.tsx'
import { Escalated, Failed, Finished, Fired, Writing } from './entry.solid.tsx'
import { openAutomationsPanel } from './navigation.web.ts'
import { AutomationsPanel } from './panel.solid.tsx'
import { AutomationsSection } from './sidebar.solid.tsx'
import { useAutomations } from './live.solid.tsx'
import { timerWaits } from './waits.web.ts'

function waitTimers() {
  const list = useAutomations(() => 5000)
  const standing = useDocOf(() => ROOT, StandingDoc)
  return createMemo(() => timerWaits(list().data, standing()))
}

export default defineWebExtension({
  provides: [provide(WaitTimers, waitTimers)],
  tools: { automation: AutomationCall },
  slots: {
    'statusline.right': [{ component: Chip, order: -2 }],
    'sidebar.top': [{ component: AutomationsSection, order: -20 }],
  },
  entries: {
    'automations.fired': Fired,
    'automations.finished': Finished,
    'automations.failed': Failed,
    'automations.escalated': Escalated,
    'automations.writing': Writing,
  },
  panels: [
    {
      id: 'automations',
      title: 'Automations',
      icon: TimerIcon,
      component: AutomationsPanel,
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
