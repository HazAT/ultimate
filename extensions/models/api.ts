/**
 * Models: the model and thinking pickers and provider logins in the composer, and the `models.pin` point through which
 * a conversation whose model lost its login finds its definition's model. Core tier.
 */
import type { ConversationId, Tx } from '@earendil-works/pi-durable'
import { defineApi } from '../../shared/extension-api.ts'
export { LoginChanged } from './refs.ts'
export type PinService = {
  /** The model the definition conversation `id` runs as pins, read inside `tx`; undefined without one. */
  pin(tx: Tx, id: ConversationId): Promise<{ provider: string; modelId: string } | undefined>
  /** The name of the agent definition conversation `id` runs as, read inside `tx`; undefined without one. */
  definitionOf(tx: Tx, id: ConversationId): Promise<string | undefined>
}
/**
 * The extension point a conversation whose model lost its login asks for the model its agent definition pins, before
 * it falls back to the default model. Subagents provides it (it records which definition a conversation runs as).
 */
export const Pin = defineApi<PinService>()('models.pin')
export const tier = 'core'
