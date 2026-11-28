import { parseConversationId } from '../../../../lib/ids.shared.ts'
import type { composeIn } from '../../dock.solid.tsx'

export async function serverEndedSession(compose: typeof composeIn) {
  compose(parseConversationId(999))
  compose(undefined)
  await Promise.resolve()
}
