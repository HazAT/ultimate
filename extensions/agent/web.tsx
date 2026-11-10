import { MessagesSquareIcon } from 'lucide-react'
import {
  Conversation,
  Header,
  Panels,
  Sidebar,
  StatusLine,
  api,
  defineWebExtension,
  getConversation,
} from '@/sdk'
import type { CommandContribution } from '@/sdk'
import { CompactAction, getRoots } from '../lineage/ui.tsx'
import { PanelActions } from './panel-actions.tsx'

/** The conversation in a centred column, with the sidebar and the right panel beside it. */
function Agent() {
  return (
    <>
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="flex min-w-0 flex-1 flex-col">
          <Header />
          <Conversation />
        </main>
        <Panels />
      </div>
      <StatusLine />
    </>
  )
}

/**
 * Commands for the shown conversation, on every surface; the palette lists them under Ultimate, with the shell's. A
 * shortcut pressed inside a `ConversationScope` (a side chat) acts on that conversation instead.
 */
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
    // A root compacts through lineage, which admits only a tally and gives it the root's summary focus.
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
    run: (context) => context.switchConversation(1),
  },
]

export default defineWebExtension({
  messages: {
    ja: {
      Agent: 'エージェント',
      'Stop the run': '実行を止める',
      'Compact the context': 'コンテキストを圧縮',
      'Focus the composer': '入力欄にフォーカス',
      'Show the main conversation': 'メインの会話を表示',
    },
  },
  // After the other items, just before the command palette button.
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
