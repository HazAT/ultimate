import { parseConversationId } from './ids.ts'
import type { ConversationId } from '@earendil-works/pi-durable'
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
  return typeof side?.of === 'number' ? parseConversationId(side.of) : id
}
