import type { ConversationId } from '@earendil-works/pi-durable'
export const landing = (
  loaded: boolean,
  chosen: unknown,
  standing: Readonly<Record<string, ConversationId>> | null | undefined,
): ConversationId | 'create' | undefined => {
  if (!loaded || chosen !== undefined || standing === undefined) return undefined
  return standing?.ultimate ?? 'create'
}
