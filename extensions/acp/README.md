Chat with external coding agents (Antigravity, OpenCode, Codex, Claude Code, any ACP agent) through the Agent Client Protocol.

The **ACP** surface lists the registered agents and your threads with them. A thread starts the agent's own
command (`agy acp`, `opencode acp`, …) in the project folder and speaks ACP to it over stdio. The agent runs its
own loop, tools, model and login; Ultimate only shows the thread and passes on your messages, model and mode
choices, cancellations and permission answers.

## Rules it keeps

- **You drive every turn.** Every action that touches an agent is user-only: no agent tool, no codemode call, no
  automation. That is what Google's Antigravity terms allow on a personal sign-in (single user, local,
  interactive), and it keeps every agent's subscription use inside its own client.
- **No auto-approval.** Permission requests show as a card with the agent's own options; nothing answers them
  for you.
- **No credentials.** Each agent signs in with its own CLI (`agy acp --login`, `opencode auth login`, `codex
  login`). Ultimate never reads or forwards tokens.
- **No client capabilities.** Ultimate offers no file system or terminal to the agent; it uses its own tools.

## Agents

Built in: `antigravity` (`agy acp`), `opencode` (`opencode acp`), `codex` (`npx -y @zed-industries/codex-acp`) and
`claude` (`npx -y @agentclientprotocol/claude-agent-acp`). Add or replace one in the project's
`.ultimate/settings.json`:

```json
{
  "acp": {
    "agents": [{ "id": "my-agent", "name": "My agent", "command": "my-agent", "args": ["acp"] }]
  }
}
```

## State

Threads live in the `acp.threads` document on conversation 1 (newest 30, each up to 400 items). The agent processes
belong to this server process: after a restart a thread shows `offline` and the next message starts the agent
again and reloads its session (`session/load`) when the agent supports it.

## Actions

`agents` lists the registered agents and whether their command is installed. User-only: `start { agent }`,
`prompt { thread, text }`, `cancel { thread }`, `permit { thread, option }` (`null` rejects), `config { thread,
option, value }`, `delete { thread }`.
