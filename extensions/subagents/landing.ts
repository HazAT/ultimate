import type { ConversationId } from '@earendil-works/pi-durable'
/**
 * Where a page opens when no conversation is chosen (a first load, a new chapter, a remembered one that is gone):
 * @ultimate's conversation, once the shared state and the standing agents are known; 'create' when @ultimate has no
 * conversation yet, as on a fresh preview. The root is only its history.
 */
export const landing = (
  loaded: boolean,
  chosen: unknown,
  standing: Readonly<Record<string, ConversationId>> | null | undefined,
): ConversationId | 'create' | undefined => {
  if (!loaded || chosen !== undefined || standing === undefined) return undefined
  return standing?.ultimate ?? 'create'
}
