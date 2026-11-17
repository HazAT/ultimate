import { parseConversationId } from './ids.ts'
import type { ConversationId, Tx } from '@earendil-works/pi-durable'
import type { Context } from '@earendil-works/chord/context'
import type { ExtensionHost } from '../server/extensions.ts'

export async function actingAs(
  host: Pick<ExtensionHost, 'doc' | 'harness'>,
  id: ConversationId,
  context: Context,
): Promise<ConversationId> {
  const sidechatByKind = host.doc('sidechat')
  if (!sidechatByKind) return id
  const side = await host.harness().snapshot(sidechatByKind, id, context)
  const readOnlyQuestionSideChatBorrowsNoIdentity = side?.question !== undefined
  return typeof side?.of === 'number' && !readOnlyQuestionSideChatBorrowsNoIdentity
    ? parseConversationId(side.of)
    : id
}

export async function isSideChat(
  host: Pick<ExtensionHost, 'doc'>,
  tx: Pick<Tx, 'doc'>,
  id: ConversationId,
): Promise<boolean> {
  const sidechatByKind = host.doc('sidechat')
  if (!sidechatByKind) return false
  return typeof (await tx.doc(sidechatByKind, id)).of === 'number'
}
