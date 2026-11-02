/** MCP: call a tool of a configured MCP server from another extension, as the `mcp` tool does. */
import type { CallToolResult } from '@earendil-works/pi-mcp'
import { defineApi } from '../../shared/extension-api.ts'

export type McpService = {
  /**
   * Call `tool` on the MCP server `server` from `mcpServers` with `args`, and return the server's raw result (content,
   * structuredContent, isError). Waits for a connect in progress; throws when the server is unknown or not connected,
   * or the call fails. A tool error is a result with `isError: true`, not a throw. Use it for panels and services that
   * read an MCP server directly instead of through an agent.
   */
  call(
    server: string,
    tool: string,
    args?: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<CallToolResult>
}
/** Calls into the configured MCP servers; `want` it, since the mcp extension may be disabled. */
export const Mcp = defineApi<McpService>()('mcp')
