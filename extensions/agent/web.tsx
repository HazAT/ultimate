import { ROOT } from '@/sdk'
import { MessagesSquareIcon } from 'lucide-react'
import { api, defineWebExtension, getConversation, island } from '@/sdk'
import type { CommandContribution } from '@/sdk'
import { CompactAction, getRoots } from '../lineage/ui.tsx'
import { PanelActions } from './panel-actions.solid.tsx'
import { Agent } from './surface.solid.tsx'

const commands: CommandContribution[] = [
  {
    id: 'agent.stop',
    title: 'Stop the run',
    keys: 'escape',
    whileTyping: true,
    when: (context) => getConversation(context.conversationId).busy,
    run: (context) => api.abort(context.conversationId),
  },
  {
    id: 'agent.compact',
    title: 'Compact the context',
    run: (context) =>
      context.conversationId !== undefined && getRoots()?.includes(context.conversationId)
        ? api.action(CompactAction, { id: context.conversationId })
        : api.compact(),
  },
  {
    id: 'agent.composer',
    title: 'Focus the composer',
    when: (context) =>
      context.conversationId === undefined || !getRoots()?.includes(context.conversationId),
    run: (context) => context.focusComposer(),
  },
  {
    id: 'agent.main',
    title: 'Show the main conversation',
    when: (context) => context.conversationId !== 1,
    run: (context) => context.switchConversation(ROOT),
  },
]

export default defineWebExtension({
  slots: { 'titlebar.right': [{ component: island(PanelActions), order: 100 }] },
  surfaces: [
    {
      id: 'agent',
      title: 'Agent',
      icon: MessagesSquareIcon,
      description: 'The conversation, with panels beside it',
      component: island(Agent),
    },
  ],
  commands: commands.map((command) => ({ group: 'Ultimate', ...command })),
})
