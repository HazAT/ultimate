/** Health in the browser: this machine's model provider health, which the status line warns about. Browser-safe. */
import { defineEvent } from '../../shared/events.ts'

/** One provider's health on this machine. */
export interface ProviderHealth {
  provider: string
  state: 'ok' | 'failing' | 'unknown'
  /** Why it is failing: its login was refused, its account hit a credit limit (402), or its calls kept failing. */
  cause?: 'auth' | 'billing' | 'transient'
  /** The last successful call. */
  lastOk?: number
  /** The last failed call. */
  lastFail?: number
  error?: string
  /** The last call. */
  lastUsed?: number
}

/**
 * Provider `provider`'s health on this machine changed to `state`; `error` is the sanitised reason of a failure. Only on
 * a change, never per call. Health lives in a file, so this commits on its own right after the write.
 */
export const Changed = defineEvent<{
  provider: string
  state: ProviderHealth['state']
  error?: string
}>('health.changed')
