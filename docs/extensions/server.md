# Server facets: host, lifecycle, tools and prompt

Part of the [extension guide](../../extensions/README.md).

`server.ts` exports a Pi Durable extension, `defineExtension({ name })` with the folder's name, or a factory
receiving the `ExtensionHost` below. See `prompt/` for prompt sections and `coding-tools/server.ts` for tools; the
root `AGENTS.md` explains reloads and durability. Local imported modules reload with the facet; a failed load leaves
the previous version installed. Besides the extension it may export `docs` ([documents](documents.md)), `actions`,
`userActions` and `pollActions` ([actions](actions.md)), `secrets` ([secrets](places.md#secrets)),
`reloadOnSettings` (below) and `order`.

## Order and prompt sections

Server facets may `export const order = -100`: lower values come first, with the default 0 keeping discovery order
(built-in → user → project, then folder name); changing it reorders the server prompt and tools once.

Prompt sections stay stable between turns: the same conversation renders the same text every time, so the prompt
stays cached. Anything that changes while a conversation runs (a count, a list, a time) goes in a per-input note
from a `beforeInput` hook instead. For example, `todos/server.ts` does not list open to-dos in a section; its
`beforeInput` returns a note only when the list changed since the conversation last saw it.

## Extension host

Server factories receive exactly these `ExtensionHost` fields (import its type only from `server/extensions.ts`):

- `ultimateRoot`, `projectRoot`, `userHome`, `home`: source, work, user and instance-state roots.
- `modelRuntime`, `settings`: Pi model/auth runtime and settings.
- `models()`: model descriptors, including availability.
- `skills(cwd)`: merged clone, user and project skills for a working directory, each with its `scope` and `overrides`.
- `restart(approved)`: request a verified core swap; the async callback records the approved generation before activation.
- `scanSubmissions(query, limit, cursor, caller)`: a page of committed submission records; it exists until Pi Durable exposes submission scans publicly.
- `chapter`: the active chapter: its name, number, the newest chapter's name and its files.
- `build()`, `system()`, `extensions()`: current build, system and extension inspection.
- `conversations()`: every conversation's summary, as `useConversations()` gives the web; empty until the harness is open.
- `projects()`: the user's central project homes read from their JSON manifests, never another project's SQLite; includes this home and live supervisor URLs.
- `projectSetup()`: whether the project has `.ultimate/` setup, the decision of its root (a linked worktree's main checkout) and its capped README.
- `projectSettings()`: the project's parsed settings, only after a local decision; otherwise empty.
- `projectExtensions()`: a read-only inventory of the project's extension folders, including replacements of active extensions.
- `setProjectDecision(local)`: remember the local/global choice and apply it through the live settings reload.
- `reloadExtensions()`: apply settings writes to the registry, browser facets and styles before returning.
- `invoke(name, action, args, signal, conversationId?)`: call an installed extension action on behalf of a conversation; rejects user-only actions.
- `harness()`, `uiState(context)`, `doc(kind)`: durable harness, root UI snapshot and exported conversation document token.
- `implement(api, value)`, `need(api)`, `want(api)`, `catalogue()`: publish and use typed process-local services; see [contracts](contracts.md). Registrations are staged until installation succeeds, replaced on reload, and removed when the facet is disabled, removed or closed; a failed replacement keeps the old provider.
- `metadata`: the core's `ultimate.metadata` conversation document, `{ title?, label? }`; the shell names a conversation
  by them, so set them on conversations you create (`subagents` labels each child with its definition).
- `emit(tx, event, data)`, `react(name, events, handler)`, `eventLog`: durable events; see [events](events.md).
- `trace`: the recorded calls (services, actions, reactor runs, tools); see [tracing](introspection.md#tracing).
- `access.allow({ origin, verify })`: register an HTTP origin with an identity verifier; returns a disposer and is automatically removed when the facet unloads or reloads. HTTP, API, and websocket upgrades use the same admission rules.
- `notice(message)`: publish a warning notice and retain it in this facet's system diagnostics for later clients, until unload/reload.
- `resource(key, create)`, `onOpen(callback)`, `onRelease(callback)`, `onClose(cleanup)`: shared reload-stable resources, async work each
  time the harness opens (at once if it is open; the server serves once it settles), async work each time before it closes while the process stays (a core swap; drop commit subscriptions there), and async cleanup. Facet-level callbacks are removed on unload/reload, with cleanup run before the replacement opens. Callbacks registered inside a shared resource's creation belong to that reload-stable resource and survive until server shutdown.
  Keep only process state in a resource (running children, in-flight promises, flags); never capture document or task
  tokens or facet functions in it, since they go stale on reload. Build those on each install around the shared state.
- `onLoadError(callback)`: run `callback(name, error)` each time an extension's server facet fails to load; facet-scoped.

## Lifecycle

Facet-registered `onOpen` and `onClose` callbacks are facet-scoped: they end on reload, disable, or unload. An `onOpen` registered after installation while the harness is already open runs immediately. Cleanup failures produce notices and do not stop the remaining facet cleanups. Callbacks registered synchronously inside a `resource()` factory are process-scoped and survive reloads until server shutdown. Process-scoped cleanups settle independently; failures produce notices without preventing core shutdown.

A server facet can export `reloadOnSettings = true` to reinstall on live settings changes even when its enablement is unchanged. Its scoped lifecycle callbacks and access registrations are cleaned up before its replacement opens.

Type imports from `server/` are fine. Runtime imports need a host capability or a visible lint exception.
