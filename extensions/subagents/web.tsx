import { NetworkIcon } from 'lucide-react'
import { defineWebExtension, ErrorReport, island, provide } from '@/sdk'
import { agentsPanel } from '../models/ui.tsx'
import { SubagentCall } from './call.solid.tsx'
import { DefinitionDialog } from './definitions.solid.tsx'
import { useErrorReport } from './error-report.tsx'
import { AgentInbox } from './inbox.solid.tsx'
import { LandOnUltimate } from './land-on-ultimate.solid.tsx'
import { AgentInput, AgentMessages } from './messages.solid.tsx'
import { AgentsPanel } from './overview.solid.tsx'
import { talkToUltimate } from './ui.tsx'

export default defineWebExtension({
  tools: { subagent: island(SubagentCall) },
  panels: [
    {
      id: agentsPanel,
      title: 'Agents',
      icon: NetworkIcon,
      component: island(AgentsPanel),
      order: 3,
    },
  ],
  entries: { 'subagents.instruction': island(AgentInput), 'subagents.report': island(AgentInput) },
  inbox: island(AgentInbox),
  provides: [provide(ErrorReport, useErrorReport)],
  slots: {
    overlay: [island(DefinitionDialog), island(LandOnUltimate)],
    'header.right': [island(AgentMessages)],
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
