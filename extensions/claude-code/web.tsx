import { TerminalIcon } from 'lucide-react'
import { defineWebExtension, island } from '@/sdk'
import { ClaudeCodePanel } from './panel.solid.tsx'

export default defineWebExtension({
  panels: [
    {
      id: 'claude-code',
      title: 'Claude Code',
      icon: TerminalIcon,
      component: island(ClaudeCodePanel),
      order: 10,
      tab: false,
    },
  ],
  commands: [
    {
      id: 'claude-code.panel',
      title: 'Claude Code setup…',
      run: (context) => context.openPanel('claude-code'),
    },
  ],
})
