Connects the MCP servers in `mcpServers` and lets agents use their tools through one `mcp` tool; the status line shows how many are connected.

## Settings

`mcpServers` takes the same shape as Claude Desktop and Cursor, so a server's config pastes in. Put it in `~/.ultimate/settings.json`, or in a project's `.ultimate/settings.json`:

```json
{
  "mcpServers": {
    "files": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/folder"]
    },
    "my-server": {
      "type": "http",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${MY_SERVER_TOKEN}" }
    }
  }
}
```

- **stdio:** `command`, optional `args`, `env` and `cwd` (default: the project root). The server inherits Ultimate's environment plus `env`.
- **Streamable HTTP:** `url` and optional `headers`. The legacy SSE transport is not supported.
- **Secrets:** `${NAME}` in `args`, `env`, `url` or `headers` is replaced by the secret `NAME` from the Secrets panel (⌘K → Secrets). Never write a token inline. Each such name is declared as a secret, so the Secrets panel lists it, set or missing, with the servers using it. A missing secret fails that server with its name and an Add button; saving it there connects the server again.
- **Precedence:** user and project servers merge by name; a project entry replaces a user entry of the same name. Project servers run commands, so they load only once the project's setup is trusted (`host.projectSettings()` is empty before).
- `"disabled": true` leaves a server out.

Saving either settings file reconnects every server. OAuth is not supported yet: a server behind OAuth needs a token or service credentials in headers.

## Tool

`mcp {server}` lists a server's tools with their input schemas; `mcp {server, tool, args}` calls one and returns its text and images. A result the server marks as an error comes back as a tool error. The tool's description names the configured servers, so the prompt changes only when the configuration does, however many tools they have. In codemode, `tools.mcp(...)` runs many calls and filters their results.

Every agent that inherits tools gets `mcp`, and @ultimate lists it in `agents/ultimate.md`. Agents with an explicit `tools` list add it there.

Calls are `replay: 'unsafe'`: a call interrupted by a restart is reported as interrupted, never sent again. A call times out after 10 minutes without progress from the server.

## Service

Other extensions call MCP tools through the `Mcp` service in `api.ts`, without an agent: `want` it (the extension may be disabled), then `call(server, tool, args?, { signal }?)` returns the server's raw `CallToolResult` (`content`, `structuredContent`, `isError`).

```ts
import { Mcp } from '../mcp/api.ts'

const mcp = host.want(Mcp)
const result = await mcp?.call('jira', 'search_issues', { jql: 'assignee = currentUser()' })
```

It shares the tool's call path: it waits for a connect in progress, times out the same way and reconnects a broken connection. It throws when the server is unknown or not connected, or the call fails; a tool error is a result with `isError: true`.

## Lifecycle

Servers connect when the server opens, each on its own: a failing one never blocks another or a turn. A failure or a dropped connection retries after 5 s, doubling up to 5 minutes. The servers close (stdio: the whole process group) when the extension reloads or Ultimate stops. A server's `tools/list_changed` notification refreshes its tool list.

## UI

The status line's `mcp 2/3` chip counts connected out of configured servers, turns red while one failed, and is hidden when none is configured. Its popover lists each server with its transport, source, state or tool count, the error and the next retry, and a reconnect button. The Extensions panel's `mcp` row lists the same servers when opened.

Actions: `status` → every server's state; `reconnect {name}` → connects one again and returns the states.
