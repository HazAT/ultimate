---
name: verify-ui
description: Check a UI change in Ultimate by looking at it with the screenshot and browser tools, on the running host or a preview. Use after changing anything a person sees (web/, a web.solid.tsx, a card, a renderer) and before reporting it done or asking for approval.
---

# Look at the change

Never claim a UI change works without an image of it.

## Where to look

- `web/` and built-in `extensions/` changes in the host's own checkout reload in the running host: omit `url`.
- A worktree, a branch or a project `.ultimate/extensions/` change does not reach the host: start a preview of the
  checkout (`instance start`) and pass its URL. `server/` or `shared/` changes need a fresh preview.

## How

- `screenshot {url}` for a still image; `selector` for one element, `fullPage` for long pages, `width: 390` for phone,
  `theme: 'light'` and `'dark'` for both themes. Omit `path` so the PNG stays outside your checkout.
- `browser {url, steps}` to drive a state with `ui` steps: every control is a ui-sdk component with a label.
  `{ui: 'query', text: 'warm'}` finds controls with their ref, state and actions; `{ui: 'act', steps: [{ref: 'System',
  action: 'press'}]}` switches surface; the composer is `{ref: 'Prompt for conversation #2', action: 'setValue', args:
  ['hi']}`; the ⌘K palette is `Command palette` then `{ref: 'Search commands', action: 'run', args:
  ['theme.toggle']}`. `act` returns what changed and what appeared: that proves the state, the screenshot shows the
  look. Prefer `query` over `snapshot`, which stops at 100 controls on a long transcript. The result lists console
  errors and failed requests: read them.
- Wait on state, never a guessed time: `{send: 'prompt'}` submits, then `{until: 'idle'}` returns when that turn is
  done, `{until: 'quiet'}` when nothing runs (branches and subagents included), `{until: {entry: 'pi.tool-result'}}`,
  `{until: {event: 'workspaces.landed', where: {…}}}`, or `{until: {ui: 'Keep warm', is: {checked: false}}}` when a
  control has that state. `conversation: <id>` targets another conversation. An `until` fails after 10 s and says
  what it saw: a control, state or event that takes longer is a bug to report, not a wait to raise. Only a model turn
  (`idle`, `quiet` or `{entry: 'assistant'}` after a `send`) passes `timeoutMs`, at most `120000`. Never sleep in an
  `eval` (`setTimeout`): wait with `until`.
- `click`, `fill` and `press` only when that interaction itself is under test, scoped to its card:
  `[data-entry-id="42"] button:has-text("Retry")`.
- `eval` reads what no control holds (transcript text, layout, styles); one expression, or an async IIFE for
  statements and `await`.
- Set up state (model, thinking, Play/Pause, abort) through the page's SDK in one `eval`, or curl the preview's HTTP
  API, not by clicking menus: `{eval: "window.ultimate.api.configure({model: {provider: 'openai-codex', modelId:
  'gpt-6.1-sol'}}, 2)"}`. Also `api.abort(id)`, `api.compact(undefined, id)`, `api.action({extension: 'pause', name:
  'play'}, null)`; `extensions/browser/README.md` has the rest.
- Call only SDK methods that exist: `window.ultimate` has `api`, `ui`, `state`, `send` and `until`
  (`web/src/sdk/test-hook.ts`), and `api`'s methods are in `web/src/sdk/api.ts`.
- Hidden elements (`meta`, `template`, a closed panel) never become visible: read them with `eval`
  (`document.querySelector('meta[name=ultimate-web]')?.content`), never a visibility wait.
- `where` matches only fields the event carries, and events never carry text: after a send, match
  `{event: 'user.input', where: {conversation: <id>, kind: 'prompt'}}`, not the prompt. Each event's fields are in
  `extensions/browser/README.md` and its `defineEvent`. Tool calls live inside `pi.assistant`; there is no
  `pi.toolCall` entry.
- Open a conversation with `?conversation=<id>`.
- Seed real state with real prompts on a preview; do not inject entries.
- To seed files into a preview's home (an agent definition, a setting), use an explicit `home`, in separate tool
  rounds: `instance start {home}` (it seeds `<home>/user/` once), `instance stop`, write into
  `<home>/user/.ultimate/`, `instance start {home}` again. Never stop and start in one round, and never create
  `<home>/user/` before the first start.

## What to check

1. Every state: loading, empty, error, one item, many items, a long title.
2. It matches its neighbours: an existing card or panel next to it, theme tokens, spacing.
3. Transcript UI, on a long conversation:
   1. scrollback: scroll up and back down; nothing jumps or reflows;
   2. live streaming: watch a reply and its tool calls stream in;
   3. folding: fold and unfold tool calls and update groups;
   4. phone width: a screenshot at `width: 390`.
4. No new console errors.

Say what you could not reach as unverified, with the reason.
