/** @jsxImportSource @solidjs/web */
import { ROOT } from '@/sdk/solid'
import { MessagesSquareIcon } from '@lucide/solid'
import { api, defineWebExtension, getConversation } from '@/sdk/solid'
import type { CommandContribution } from '@/sdk/solid'
import { CompactAction, getRoots } from '../lineage/ui.solid.tsx'
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
  slots: { 'titlebar.right': [{ component: PanelActions, order: 100 }] },
  surfaces: [
    {
      id: 'agent',
      title: 'Agent',
      icon: MessagesSquareIcon,
      description: 'The conversation, with panels beside it',
      component: Agent,
    },
  ],
  commands: commands.map((command) => ({ group: 'Ultimate', ...command })),
})
