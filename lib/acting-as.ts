import type { ConversationId, Tx } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../server/extensions.ts'

export async function isSideChat(
  host: Pick<ExtensionHost, 'doc'>,
  tx: Pick<Tx, 'doc'>,
  id: ConversationId,
): Promise<boolean> {
  const fork = host.doc('side-chat.fork')
  return fork !== undefined && typeof (await tx.doc(fork, id)).of === 'number'
}
