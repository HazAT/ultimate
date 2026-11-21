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
- `browser {url, steps}` to drive a state: `click`, `fill` (`#composer-input` is the composer), `press`
  (`Control+k` opens ⌘K), `wait`, `eval`. The result lists console errors and failed requests: read them.
- `eval` takes one expression and returns its value: `document.title`,
  `[...document.querySelectorAll('[data-entry-id]')].length`. Statements or `await` go in an async IIFE:
  `(async () => { const r = await fetch('/api/x'); return r.status })()`. A bare `const x = …; return x` fails.
- Scope selectors to the card or panel under test: `[data-entry-id="42"] button:has-text("Retry")`, not
  `button:has-text("Retry")`, which fails when it matches several.
- Wait on Ultimate's state, never a guessed time: `{send: 'prompt'}` submits without the composer, then
  `{until: 'idle'}` returns when that turn is done, `{until: 'quiet'}` when nothing runs (branches and subagents
  included), `{until: {entry: 'pi.tool-result'}}` or `{until: {event: 'workspaces.landed', where: {…}}}` when that
  appears. A timeout says what was still busy. `conversation: <id>` targets another conversation. Click and fill only
  when the interaction itself is under test; never a fixed `wait <ms>`.
- Set up state (model, thinking, Play/Pause, abort) through the page's SDK in one `eval`, or curl the preview's HTTP
  API, not by clicking menus: `{eval: "window.ultimate.api.configure({model: {provider: 'openai-codex', modelId:
  'gpt-6.1-sol'}}, 2)"}`. Also `api.abort(id)`, `api.compact(undefined, id)`, `api.action({extension: 'pause', name:
  'play'}, null)`; `extensions/browser/README.md` has the rest.
- Call only SDK methods that exist: `window.ultimate` has `api`, `state`, `send` and `until` (`web/src/sdk/test-hook.ts`),
  and `api`'s methods are in `web/src/sdk/api.ts`; `rg` there or `{eval: 'Object.keys(window.ultimate.api)'}` first.
  Guessed ones (`api.openPanel`, `ultimate.ready`) fail as "is not a function".
- Hidden elements (`meta`, `template`, a closed panel) never become visible: read them with `eval`
  (`document.querySelector('meta[name=ultimate-web]')?.content`), never a visibility wait.
- `where` matches only fields the event carries, and events never carry text: after a send, match
  `{event: 'user.input', where: {conversation: <id>, kind: 'prompt'}}`, not the prompt. Each event's fields are in
  `extensions/browser/README.md` and its `defineEvent`. Tool calls live inside `pi.assistant`; there is no
  `pi.toolCall` entry.
- Open a conversation with `?conversation=<id>`. Right-panel section titles show their source text in sentence case
  (the `section-label` utility); match them with `textContent.startsWith('Skills')`, since counts and meta follow.
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
