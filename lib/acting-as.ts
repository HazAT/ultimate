import type { Context } from '@earendil-works/chord/context'
import type { ConversationId } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../server/extensions.ts'

/** Temporary copies act for their long-lived main. Read by kind to keep core extensions independent of side chats. */
export async function actingAs(
  host: Pick<ExtensionHost, 'doc' | 'harness'>,
  id: ConversationId,
  context: Context,
): Promise<ConversationId> {
  const doc = host.doc('sidechat')
  if (!doc) return id
  const side = await host.harness().snapshot(doc, id, context)
  return (typeof side?.of === 'number' ? side.of : id) as ConversationId
}
