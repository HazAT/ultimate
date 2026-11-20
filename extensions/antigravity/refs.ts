/** Antigravity in the browser: whether the local `agy` CLI is installed and signed in, and its models. Browser-safe. */
import { actionRef } from '../../shared/extension-api.ts'

/** The CLI's status metadata; never its output or the account's identity. */
export type AntigravityStatus = {
  available: boolean
  loggedIn: boolean
  /** Display names of the models `agy models` lists. */
  models: string[]
}

/** No arguments → runs `agy models` and refreshes the Antigravity models in the registry. */
export const StatusAction = actionRef<null, AntigravityStatus>('antigravity', 'status')
