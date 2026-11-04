---
name: write-extension
description: Build or change an Ultimate extension or surface (a panel, status-line item, tool or entry renderer, command, dialog, full-screen app, server tool or prompt section) in extensions/ or a project's .ultimate/extensions/. Use before writing a new extension folder or adding a contribution to one; not for small fixes inside an existing renderer.
---

# Write an Ultimate extension

`extensions/README.md` (in the Ultimate clone) is the full reference, about 20k tokens. Do not read it whole: follow
these steps and read only the sections named.

## 1. Place it

- A built-in Ultimate feature: `extensions/<name>/` in the clone.
- One project's tool or app: `<project>/.ultimate/extensions/<name>/` (in Ultimate's own repo that is
  `.ultimate/extensions/`, not `extensions/`).
- Personal, every project: `~/.ultimate/extensions/<name>/`.

The folder name is the extension name. New UI is a new folder, never a change to `web/`.

## 2. Copy the closest extension

Read the table at the top of `extensions/README.md` and open the extension it names for what you build
(`status-line`, `models`, `info`, `coding-tools`, `plan`, the Commits example). Copy its shape; change the content.

## 3. Pick the facets

| File        | For                                                             | Goes live           |
| ----------- | --------------------------------------------------------------- | ------------------- |
| `web.tsx`   | UI: `defineWebExtension({ slots, panels, surfaces, tools, … })` | Rebuilt on save     |
| `server.ts` | tools, prompt sections, hooks, documents, `actions`             | reinstalled on save |
| `api.ts`    | a typed service other extensions call                           | with its importers  |
| `refs.ts`   | typed refs of your actions and documents for the browser        | with its importers  |
| `README.md` | required; first paragraph is one sentence the UI shows          | read on change      |

Read in `extensions/README.md` only what you use: "Contributions" and its subsection (Slots, Panels, Surfaces, Tool
renderers, Entry renderers, Commands, Documents), "Actions", "Extension APIs", "SDK", "Styling", "Conventions".
For a full app, "Build an app, step by step".

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
2. `pnpm check` in the clone (format, lint, types, import boundaries, the dependency graph).
3. Tests for behaviour behind it: fast tests in `test/`, no real waits.
4. Look at it: follow the `verify-ui` skill (a preview of your checkout for anything outside the running host).
