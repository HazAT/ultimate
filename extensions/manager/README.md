The Extensions panel: turn extensions on and off live, see what each one offers, and decide whether this project's own setup applies.

## Extensions panel

The right-panel tab (palette **Extensions…**) shows the project decision, a way to change it, Use this project's setup
everywhere, and every extension with its source, deciding layer, README line and switch. Switches save everywhere
(`~/.ultimate/settings.json`) unless you pick this project (when its setup is in use): a project's settings file is
usually committed, so a personal toggle never lands there by default. A core-tier extension's switch stays on and disabled, its deciding layer
reads `core`: the server keeps the core tier enabled whatever the settings say. Failures show on the row; the list
follows system info. Clicking a row opens it in place (open rows are kept in UI state): its tools with their
description's first line, contract summary, what it provides, needs and wants, actions, documents, events, web
contributions, secrets, prompt sections and hooks, and its folder. Empty groups share one dim line. Another extension
adds to an open row through the `ExtensionDetails` point (`ui.solid.tsx`); `mcp` lists its servers there.

**About this setup** opens the `projectHelpDialog` dialog id; `onboarding` answers it by asking @ultimate about the
project's setup in its conversation.

The extension is core tier: it is the only way to turn an extension back on, and it holds the project decision.

## Actions

Settings and trust writes are user-only: agents cannot apply them through codemode `tools.action`.

- `extensions`: discovered names, sources, effective enablement, deciding layers and README first sentences.
- `details { name }`: the extension's contract summary (first api.ts or refs.ts doc sentence), the catalogue APIs it
  provides, declares, needs and wants, and the events its contract files define.
- `decide { local }`: saves the project choice through Pi's `ProjectTrustStore` and reloads extensions/web facets.
  Linked worktrees share their main checkout's choice. User-only.
- `setExtension { name, enabled, scope }`: updates user or project settings, preserving other keys. Project writes
  require a local decision. User-only.
- `adoptProjectSetup`: merges project enable/disable lists into user settings. User-only.

Undecided projects use global configuration. Only a local decision enables project extension folders, settings,
agents and skills. Settings writes go through `lib/settings.ts` (`extensionLists`, `toggleExtension`), which
onboarding's first-run choices share.
