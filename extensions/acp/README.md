Chat directly with Antigravity through Google's official Agent Client Protocol (ACP) server.

Install the Antigravity CLI and run `agy acp --login` or `agy` interactively once. Enable `acp` in Ultimate's Extensions tab. Open the model picker and find **Antigravity** under **acp**. Enter opens a conversation in the project; **worktree** opens it in a new worktree.

With a consumer sign-in, Google allows a custom ACP client only when a person directly drives the session ([Google's November 12, 2026 clarification](https://github.com/google-antigravity/antigravity-cli/issues/1493)). Type and send each prompt yourself. Ultimate passes only that text to `agy acp`: no system prompt, tools, MCP servers, or transcript history. The ACP controls accept only person-attributed UI calls, so Ultimate's agents, agent-driven pages, automations, steers and notes cannot reach them. As with other user-only actions, Ultimate cannot stop a local script that forges the attribution header. The CLI owns its login and tools; Ultimate does not read credentials or offer filesystem or terminal capabilities over ACP.

Replies, thinking and tool calls stream into the transcript. When Antigravity asks permission, the card shows its own options; Ultimate never approves on your behalf. Use the composer controls to select the model, mode or thinking options Antigravity provides. Stop or Esc cancels the current turn. After the CLI exits or Ultimate restarts, the conversation goes offline. The next prompt you send reconnects and loads Antigravity's session without replaying the transcript.

`ULTIMATE_AGY_COMMAND` overrides the executable (defaults to `agy`). Tests use a fake ACP agent.
