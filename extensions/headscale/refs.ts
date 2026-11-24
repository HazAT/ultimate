/**
 * Headscale in the browser: whether this server is published on the tailnet's mesh, the action that tries again after
 * fixing what blocked it, and the mesh node picker. Browser-safe.
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
    | 'port-conflict'
    | 'error'
  url?: string
  /** The same page over the node's mesh address, for peers whose MagicDNS does not resolve the name. */
  meshUrl?: string
  /** Who may open it: node DNS names, host names, or mesh addresses. */
  allow: string[]
  hint?: string
}

/** No arguments → this server's publication status. */
export const StatusAction = actionRef<null, Status>('headscale', 'status')
/** No arguments → the status reached after starting the publication again; a ready one stays as it is. */
export const RetryAction = actionRef<null, Status>('headscale', 'retry')
/** Mesh mode: every node the tailnet reports, who may connect, and this node itself. */
export type MeshPeers = {
  peers: {
    name: string
    ips: string[]
    self: boolean
    allowed: boolean
    online: boolean
  }[]
}
/** No arguments → the tailnet's nodes and who of them may connect. */
export const PeersAction = actionRef<null, MeshPeers>('headscale', 'peers')
/**
 * The new `headscale.allow` (node DNS names, host names or mesh addresses) → the status after the settings reload it
 * starts. The mesh listener refuses to forward it, so only the machine's own browser can change who may connect.
 */
export const AllowAction = actionRef<{ allow: readonly string[] }, Status>('headscale', 'allow')
