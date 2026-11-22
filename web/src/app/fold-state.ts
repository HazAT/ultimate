import type { ConversationId } from '@earendil-works/pi-durable'

export const foldKey = (conversation: ConversationId | undefined, card: string | number) =>
  `ultimate.fold.${conversation ?? 0}.${card}`

export const readFold = (key: string) => localStorage.getItem(key) === 'open'
export function writeFold(key: string, open: boolean) {
  if (open) localStorage.setItem(key, 'open')
  else localStorage.removeItem(key)
}
