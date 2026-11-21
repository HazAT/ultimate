/** MCP in the browser: each configured server's connection state, and the action that connects one again. Browser-safe. */
import { actionRef } from '../../shared/extension-api.ts'

/** One server from `mcpServers` in user or project settings, as the `mcp` tool sees it now. */
export type McpServerStatus = {
  name: string
  /** Which settings file it comes from; a project entry replaces a user one of the same name. */
  source: 'user' | 'project'
  transport: 'stdio' | 'http'
  /** `off`: switched off for this project in the user's `~/.ultimate/mcp.json`; agents here do not see it. */
  state: 'connecting' | 'connected' | 'failed' | 'off'
  /** It runs only in the projects the user listed for it. */
  only?: boolean
  /** How many tools it offers, once connected. */
  tools?: number
  error?: string
  /** The `${NAME}` secret its last connect could not find, until it connects again. */
  missing?: string
  /** When the next attempt runs (ms), while it is failed. */
  retryAt?: number
}

/** No arguments → every configured server's state, in settings order. */
export const StatusAction = actionRef<null, McpServerStatus[]>('mcp', 'status')
/** `{ name }` → connects that server again now, and returns every server's state once it is connected or failed. */
export const ReconnectAction = actionRef<{ name: string }, McpServerStatus[]>('mcp', 'reconnect')
/** `{ name, enabled }` → switches it on or off for this project; `{ name, only }` → `true` runs it only in this project, `false` everywhere again. Written to the user's `~/.ultimate/mcp.json`; the extension reloads itself. */
export const ChooseAction = actionRef<{ name: string; enabled?: boolean; only?: boolean }, null>(
  'mcp',
  'choose',
)
