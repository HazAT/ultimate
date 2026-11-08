# Writing extensions

Almost everything in Ultimate is an extension: tools, prompt sections, tool renderers, the status line, panels, and
whole apps, called surfaces. Even the Agent surface, the conversation you probably talk to Ultimate in, is one
(`agent`). The web core only provides the frame: a surface host, the primitives surfaces are built from, the live data
layer, the transcript, the composer, and the command palette. New UI is a new extension folder. Copy the closest
existing extension and change it, then open only the [topic](#topics) you need:

- A full-screen app with the agent docked beside it, or server data in the UI (actions):
  [the Commits example](../docs/extensions/example-app.md).
- A surface made of the shell's own parts: `agent`. A status-line item: `status-line`.
- Tool renderers (diffs, terminals, images): `coding-tools`, `browser`, `instance`.
- A right-panel tab: `info` (key/value sections), `tasks`, `subagents`.
- Toolbar buttons, dialogs, commands, a popover: `models`.
- A status-line action, an entry renderer over core: `self`.
- An extension document in the UI (`useDoc`): `plan`, `codemode` (renderers), `models` (`useDoc`); a renderer for
  your document (Documents tab): `plan`.
- Toasts or other global overlays: `notices`.

## An extension's files

An extension is a folder `<name>/` in `extensions/` (built-in), `~/.ultimate/extensions/` (user) or
`<project>/.ultimate/extensions/` (project; see [places](../docs/extensions/places.md)):

- `server.ts`: agent and server, a Pi Durable extension (tools, prompt sections, hooks, documents) and its `actions`.
  Reinstalled on save; running tool calls finish on old code.
- `web.tsx`: UI, `export default defineWebExtension({ … })`. Rebuilt on save; open pages switch to the new bundle.
- `api.ts`, `refs.ts`, `ui.tsx`: its [contracts](../docs/extensions/contracts.md) for other extensions; live with the
  facets that import them.
- `README.md`: what it does; the first paragraph is shown in the UI, so open with a sentence, not a heading.
  Required; read on change.

Files ending in `.ts` belong to the server facet, files ending in `.tsx` to the web facet: split a large `web.tsx` into
more `.tsx` files in the same folder (see `coding-tools/diff.tsx`). The folder name is the extension name; a
`server.ts` extension must use it as its `name`.

Each web facet loads on its own. If it fails to compile, throws, or exports a contribution of the wrong shape (such as
`surfaces: {}` instead of an array, or a command without `run`), an error card names it and the rest of the UI keeps
running; its previous version stays installed until the fix lands. Every contribution renders inside its own error
boundary, so a crashing component shows a compact card where it was.

## A first extension

```tsx
// extensions/hello/web.tsx
import { defineWebExtension, useConversation } from '@/sdk'

function Entries() {
  const { entries } = useConversation()
  return <span>{entries.length} entries</span>
}

export default defineWebExtension({
  slots: { 'statusline.left': [Entries] },
})
```

Add a `README.md`, and the item appears in the status line.
For a project extension, use `<project>/.ultimate/extensions/hello/` instead; it is enabled automatically too.
No restart, no reload.

## Conventions

- One feature per folder; the folder name is the extension name; a README is required. Keep it small.
- Prefer documents, commands, events, or the SDK. Another extension's runtime code is reached only through its
  `api.ts` on the server and its `ui.tsx` in the browser; type imports are free. Lint enforces both.
- Shared pure helpers live in the top-level `lib/`, not in another extension: `exec.ts` (run a program), `git.ts`
  (git and isolation checks), `json-file.ts` (read, atomic write, serialised update), `settings.ts`, `secrets.ts`
  (read-only), `cloud.ts` (the user's cloud settings), `project-identity.ts` (a project's GitHub key), `entries.ts`
  (`isInput`) and `agents.ts` (agent definitions and their discovery). Import them freely; they reload with the
  extensions that import them. `lib/` holds no state and imports no extension or `web/` code; only `agents.ts` reads
  the core project trust decision at runtime.

## Topics

One file each in `docs/extensions/`:

- [places](../docs/extensions/places.md): built-in, user and project folders; enabling, disabling; tool-name
  layering; declaring secrets; agents and skills.
- [server](../docs/extensions/server.md): server facets, the `ExtensionHost` fields, lifecycle and resources,
  `reloadOnSettings`, `order`, prompt sections.
- [contracts](../docs/extensions/contracts.md): `api.ts` services and extension points, `refs.ts`, `ui.tsx`, web
  points, the `api-*` lint rules.
- [core-tier](../docs/extensions/core-tier.md): the always-on core tier, its layers, one-way dependencies,
  `pnpm deps`.
- [events](../docs/extensions/events.md): durable events and reactors, today's events, the browser `events` bus,
  `useReady`.
- [actions](../docs/extensions/actions.md): server `actions`, `ActionContext`, `useAction` and `api.action`,
  `userActions`, `pollActions`.
- [documents](../docs/extensions/documents.md): exporting documents, Documents tab renderers, the `/api/events`
  stream.
- [slots](../docs/extensions/slots.md): the `defineWebExtension` keys, the slot table, panels, the surface
  contribution.
- [renderers](../docs/extensions/renderers.md): tool, link, code-block, entry, inbox and composer renderers; message
  actions, details and labels; compact mode.
- [commands](../docs/extensions/commands.md): palette commands, shortcuts, `when`, dialogs.
- [surfaces](../docs/extensions/surfaces.md): full-screen apps, switching, layout, primitives.
- [example-app](../docs/extensions/example-app.md): a complete Commits app; building an app step by step.
- [sdk](../docs/extensions/sdk.md): `@/sdk` hooks, `api`, helpers, UI state, `ConversationScope`.
- [styling](../docs/extensions/styling.md): components, theme tokens, `data-ui` theming hooks.
- [introspection](../docs/extensions/introspection.md): the call trace; inspecting yourself with codemode.
