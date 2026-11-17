/**
 * Models: the model and thinking pickers and provider logins in the composer, and the `models.pin` point through which
 * a conversation whose model lost its login finds its definition's model. Core tier.
 */
import { defineDoc } from '@earendil-works/pi-durable'
import type { ConversationId, Tx } from '@earendil-works/pi-durable'
import { defineApi } from '../../shared/extension-api.ts'
import { FamilyDoc } from './refs.ts'
export { LoginChanged } from './refs.ts'

/**
 * The family a conversation runs as (`FamilyDoc`): whoever configures a conversation from a definition writes it in the
 * same commit (`definitionFamily` in lib/agents.ts), the picker when it picks a family or a model, the fallback when it
 * switches the model. A fork starts with its source's.
 */
export const Family = defineDoc<{ name: string | null }>({
  kind: FamilyDoc.kind,
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'current',
  initial: () => ({ name: null }),
})
export type PinService = {
  /** The model the definition conversation `id` runs as pins, read inside `tx`; undefined without one. */
  pin(tx: Tx, id: ConversationId): Promise<{ provider: string; modelId: string } | undefined>
}
/**
 * The extension point a conversation whose model lost its login asks for the model its agent definition pins, before
 * it falls back to the default model. Subagents provides it (it records which definition a conversation runs as).
 */
export const Pin = defineApi<PinService>()('models.pin')
export const tier = 'core'
