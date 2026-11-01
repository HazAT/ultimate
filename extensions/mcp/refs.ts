/** MCP in the browser: each configured server's connection state, and the action that connects one again. Browser-safe. */
import { actionRef } from '../../shared/extension-api.ts'

/** One server from `mcpServers` in user or project settings, as the `mcp` tool sees it now. */
export type McpServerStatus = {
  name: string
  /** Which settings file it comes from; a project entry replaces a user one of the same name. */
  source: 'user' | 'project'
  transport: 'stdio' | 'http'
  state: 'connecting' | 'connected' | 'failed'
  /** How many tools it offers, once connected. */
  tools?: number
  error?: string
  /** When the next attempt runs (ms), while it is failed. */
  retryAt?: number
}

/** No arguments → every configured server's state, in settings order. */
export const StatusAction = actionRef<null, McpServerStatus[]>('mcp', 'status')
/** `{ name }` → connects that server again now, and returns every server's state once it is connected or failed. */
export const ReconnectAction = actionRef<{ name: string }, McpServerStatus[]>('mcp', 'reconnect')
