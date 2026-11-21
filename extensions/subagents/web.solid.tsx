/** @jsxImportSource @solidjs/web */
import { NetworkIcon } from '@lucide/solid'
import { defineWebExtension, ErrorReport, provide } from '@/sdk/solid'
import { agentsPanel } from '../models/ui.solid.tsx'
import { SubagentCall } from './call.solid.tsx'
import { DefinitionDialog } from './definitions.solid.tsx'
import { errorReport } from './error-report.solid.tsx'
import { AgentInbox } from './inbox.solid.tsx'
import { LandOnUltimate } from './land-on-ultimate.solid.tsx'
import { AgentInput, AgentMessages } from './messages.solid.tsx'
import { AgentsPanel } from './overview.solid.tsx'
import { talkToUltimate } from './ui.solid.tsx'

export default defineWebExtension({
  tools: { subagent: SubagentCall },
  panels: [
    {
      id: agentsPanel,
      title: 'Agents',
      icon: NetworkIcon,
      component: AgentsPanel,
      order: 3,
    },
  ],
  entries: { 'subagents.instruction': AgentInput, 'subagents.report': AgentInput },
  inbox: AgentInbox,
  provides: [provide(ErrorReport, () => () => errorReport)],
  slots: {
    overlay: [DefinitionDialog, LandOnUltimate],
    'header.right': [AgentMessages],
  },
  commands: [
    {
      id: 'subagents.ultimate',
      title: 'Talk to @ultimate',
      keys: 'mod+0',
      run: (context) => talkToUltimate(context),
    },
    {
      id: 'subagents.open',
      title: 'Show agent definitions',
      run: (context) => context.openPanel(agentsPanel),
    },
  ],
})
