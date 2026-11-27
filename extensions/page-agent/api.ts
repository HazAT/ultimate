/** The page agent's extension point: which page runs a conversation's `ui` requests. */
import type { Context } from '@earendil-works/chord/context'
import type { ConversationId } from '@earendil-works/pi-durable'
import { defineApi } from '../../shared/extension-api.ts'

export type PageAgentPagesService = {
  /**
   * The page (its `pageId` from `ui.solid.tsx`) that runs the `ui` request `conversation` makes now, read from what is
   * committed; `undefined` lets any visible page run it.
   */
  pageFor(conversation: ConversationId, context: Context): Promise<string | undefined>
}
/** Implemented by the extension whose conversations call `ui` (voice); page-agent `want`s it on every request. */
export const PageAgentPages = defineApi<PageAgentPagesService>()('page-agent.pages')
