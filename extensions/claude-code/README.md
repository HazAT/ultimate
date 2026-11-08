Claude Code is an experimental provider that uses the external CLI login, with a setup panel and no in-app OAuth flow.

It is on by default; turn it off with `claude-code` in `extensions.disable`. Existing Anthropic models and the default
model are unchanged.

## Setup

Install the CLI with `npm install -g @anthropic-ai/claude-code`, then run `claude auth login` in a terminal. Open
**Claude Code setup…** in the command palette and refresh status. Once the CLI reports a login, pick a Claude Code model
in the model picker. Login and logout stay external (`claude auth logout`); refresh after changing them, and the picker
follows without a page reload. A status the CLI cannot report reads as an unconfirmed login, and a failed check can be
retried.

No credentials are read, copied or logged. Status exposes only availability, login, subscription and plan, never account
identity or raw CLI output.

## Contract

- **Upstream:** `earendil-works/pi-claude-code`, pinned to an immutable commit in `package.json` and patched in
  `patches/`. Ultimate reuses its provider, status and environment helpers, process cleanup, streaming transport and
  billing guard, minus its in-app OAuth login.
- **Environment:** `PI_CLAUDE_CODE_COMMAND` selects the CLI executable, `PI_CLAUDE_CODE_CONFIG_DIR` its config
  directory. Requests default `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, so the CLI's auto-memory stays out of a conversation
  that has Ultimate's own; set it to `0` in the launch environment or the hook to opt back in.
- **Per-conversation hook:** another extension can implement the optional `ClaudeCodeEnv` API (`api.ts`,
  `claude-code.env`) to set those variables per conversation, for example a project's own Claude Code config directory.
  Each distinct environment gets its own warm CLI process. The hook selects an environment only; it does not report
  usage or rate limits back, and rotating subscription accounts around usage limits is outside what Anthropic's Claude
  Code terms allow for Pro and Max plans.
- **Tool ids** from other providers (an OpenAI `call_…|fc_…` id) are rewritten where the transcript is built, so
  stored history is unchanged.

## Costs and limits

Experimental: it depends on Claude Code's protocol and account limits, and subscription coverage is not guaranteed.
Displayed costs are list-price accounting, not your bill. Upstream rejects conflicting API or backend overrides and stops
further requests when usage-credit overage is reported, but the first response may already be charged; this extension
never sets `PI_CLAUDE_CODE_ALLOW_USAGE_CREDITS` or alters that guard. Read the
[upstream documentation](https://github.com/earendil-works/pi-claude-code) before using it.

Tests: `test/e2e/claude-code.test.ts`, against a fake CLI.
