import type { ConversationId } from '@earendil-works/pi-durable'
import { inProcess } from '../../lib/errors.ts'
import { get, refreshAutomations, type FetchList } from './poll.ts'

type PanelShell = {
  showSurface: (id: string) => void
  openPanel: (id?: string) => void
}

export function openAutomationsPanel(shell: PanelShell) {
  shell.showSurface('agent')
  shell.openPanel('automations')
}

export function openAutomation(
  id: string,
  shell: PanelShell & { switchConversation: (id: ConversationId) => void },
  fetchList: FetchList,
) {
  const find = () => get().data?.find((automation) => automation.id === id)
  const show = (to: ConversationId | undefined) => {
    if (to !== undefined) shell.switchConversation(to)
    openAutomationsPanel(shell)
  }
  const automation = find()
  if (automation) return show(automation.script?.conversationId)
  inProcess(
    'Find the watcher before opening the panel in this tab',
    refreshAutomations(fetchList).then(() => show(find()?.script?.conversationId)),
  )
}
