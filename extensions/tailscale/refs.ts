/**
 * Tailscale in the browser: whether this server is published on the user's tailnet, and the action that tries again
 * after fixing what blocked it. Browser-safe.
 */
import { actionRef } from '../../shared/extension-api.ts'

/** The publication state, the tailnet `url` once ready, and a `hint` when something blocks it. */
export type Status = {
  state:
    | 'disabled'
    | 'starting'
    | 'ready'
    | 'not-installed'
    | 'not-running'
    | 'not-operator'
    | 'https-disabled'
    | 'port-conflict'
    | 'error'
  url?: string
  /** How it is published: Serve over HTTPS by default, or a mesh listener over WireGuard-encrypted HTTP. */
  mode?: 'serve' | 'mesh'
  /** Who may open it: logins in serve mode, node DNS names, host names, or mesh addresses in mesh mode. */
  allow: string[]
  hint?: string
}

/** No arguments → this server's publication status. */
export const StatusAction = actionRef<null, Status>('tailscale', 'status')
/** No arguments → the status reached after starting the publication again; a ready one stays as it is. */
export const RetryAction = actionRef<null, Status>('tailscale', 'retry')
