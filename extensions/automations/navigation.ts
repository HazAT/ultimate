import type { ConversationId } from '@earendil-works/pi-durable'
import { inProcess } from '../../lib/errors.ts'
import { ListAction } from './refs.ts'
import type { AutomationListItem } from './refs.ts'

export type FetchList = (ref: typeof ListAction) => Promise<AutomationListItem[]>

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
  const show = (to: ConversationId | undefined) => {
    if (to !== undefined) shell.switchConversation(to)
    openAutomationsPanel(shell)
  }
  inProcess(
    'Find the watcher before opening the panel in this tab',
    fetchList(ListAction).then(
      (list) => show(list.find((automation) => automation.id === id)?.script?.conversationId),
      () => show(undefined),
    ),
  )
}
