import type { ConversationId } from '@earendil-works/pi-durable'
import { useUltimate, useUiState } from '@/sdk'
import type { JsonValue } from '@/sdk'

/** The sidebar's durable UI state, under the keys it had as part of conversations (`ext.conversations.<key>`). */
export const useSidebarState = <T extends JsonValue>(key: string, initial: T) =>
  useUiState<T>(`ext.conversations.${key}`, initial)

/**
 * The shell's actions for sidebar rows: the sidebar also shows beside surfaces other than Agent (Memory), so opening a
 * conversation from a row brings Agent back, also when that conversation is already the shown one.
 */
export function useShell() {
  const actions = useUltimate()
  return {
    ...actions,
    switchConversation: (id: ConversationId, options?: { replace?: boolean }) => {
      actions.showSurface('agent')
      actions.switchConversation(id, options)
    },
  }
}
