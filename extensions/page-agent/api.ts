/** The page agent for other extensions: name the page that runs a conversation's `ui` requests. */
import type { ConversationId, Tx } from '@earendil-works/pi-durable'
import { defineApi } from '../../shared/extension-api.ts'

export type PageAgentService = {
  /**
   * Name the page (its `pageId` from `ui.solid.tsx`) that runs the `ui` requests `conversation` makes from now on,
   * inside the caller's transaction; `undefined` lets any visible page run them.
   */
  namePage(tx: Tx, conversation: ConversationId, page: string | undefined): Promise<void>
}
/** The page agent; `need` it from an extension that `requires` page-agent. */
export const PageAgentApi = defineApi<PageAgentService>()('page-agent')
