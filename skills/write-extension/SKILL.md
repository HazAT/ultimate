---
name: write-extension
description: Build or change an Ultimate extension or surface (a panel, status-line item, tool or entry renderer, command, dialog, full-screen app, server tool or prompt section) in extensions/ or a project's .ultimate/extensions/. Use before writing a new extension folder or adding a contribution to one; not for small fixes inside an existing renderer.
---

# Write an Ultimate extension

`extensions/README.md` (in the Ultimate clone) is a short index; each topic is its own file in `docs/extensions/`.
Follow these steps and open only the topics named.

## 1. Place it

- A built-in Ultimate feature: `extensions/<name>/` in the clone.
- One project's tool or app: `<project>/.ultimate/extensions/<name>/` (in Ultimate's own repo that is
  `.ultimate/extensions/`, not `extensions/`).
- Personal, every project: `~/.ultimate/extensions/<name>/`.

The folder name is the extension name. New UI is a new folder, never a change to `web/`.

## 2. Copy the closest extension

Read the table at the top of `extensions/README.md` and open the extension it names for what you build
(`status-line`, `models`, `info`, `coding-tools`, `plan`, the Commits example in `docs/extensions/example-app.md`). Copy its shape; change the content.

## 3. Pick the facets

| File        | For                                                             | Goes live           |
| ----------- | --------------------------------------------------------------- | ------------------- |
| `web.tsx`   | UI: `defineWebExtension({ slots, panels, surfaces, tools, … })` | Rebuilt on save     |
| `server.ts` | tools, prompt sections, hooks, documents, `actions`             | reinstalled on save |
| `api.ts`    | a typed service other extensions call                           | with its importers  |
| `refs.ts`   | typed refs of your actions and documents for the browser        | with its importers  |
| `ui.tsx`    | components and hooks other extensions' browser code imports     | with its importers  |
| `README.md` | required; first paragraph is one sentence the UI shows          | read on change      |

Open in `docs/extensions/` only what you use: `slots.md` (slots, panels), `renderers.md` (tool, entry, link and
composer renderers), `commands.md`, `documents.md`, `surfaces.md`, `actions.md`, `contracts.md` (`api.ts`, `refs.ts`,
`ui.tsx`), `events.md`, `server.md` (host, tools, prompt sections), `sdk.md`, `styling.md`. For a full app,
`example-app.md`. The index's Topics table says what each covers.

## 4. Rules that bite

- Import only `@/sdk`, `@/components/ui/*`, `@/components/ai/*`, `react`, `lucide-react`; never `fetch` your own
  server, use actions. Another extension only through its `api.ts` (server) or `ui.tsx` (browser).
- Ids (surface, command, dialog) start with the extension name.
- Prompt sections stay stable between turns; anything that changes goes in a `beforeInput` note.
- An outcome a user waits for gets a card that matches existing ones (`extensions/subagents/messages.tsx`,
  `extensions/workspaces/log.tsx`), never raw Markdown.
- Theme tokens only (`text-brand`, `text-muted-foreground`, `border-border/70`); dense and quiet, `font-mono` for meta.

## 5. Verify

1. Server actions first: call them with codemode `ultimate.action(extension, action, args)`.
2. In the clone, `pnpm check` (format, lint, types, import boundaries, the dependency graph). For an extension of another
   project or a user extension, `node <clone>/scripts/check-extension.ts [folder…]` from the project (default: its
   `.ultimate/extensions/*`) type-checks it against the clone. Never copy an extension into the clone to check it: the
   running host would load it.
3. Tests for behaviour behind it: fast tests in the extension's own `test/` folder (`extensions/<name>/test/`), no
   real waits; run them alone with `pnpm test extensions/<name>/` (see "Tests" in `extensions/README.md`).
4. Look at it: follow the `verify-ui` skill (a preview of your checkout for anything outside the running host).
