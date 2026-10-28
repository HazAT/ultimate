# Writing extensions

Almost everything in Ultimate is an extension: tools, prompt sections, tool renderers, the status line, panels, and
whole apps, called surfaces. Even the Agent surface, the conversation you probably talk to Ultimate in, is one
(`agent`). The web core only provides the frame: a surface host, the primitives surfaces are built from, the live data
layer, the transcript, the composer, and the command palette. New UI is a new extension folder. Copy the closest
existing extension and change it:

| Want                                              | Copy                                                |
| ------------------------------------------------- | --------------------------------------------------- |
| A full-screen app with the agent docked beside it | [the Commits example](#example-a-commits-app) below |
| Server data in the UI (actions)                   | [the Commits example](#example-a-commits-app) below |
| A surface made of the shell's own parts           | `agent`                                             |
| A status-line item                                | `status-line`                                       |
| Tool renderers (diffs, terminals, images)         | `coding-tools`, `browser`, `instance`               |
| A right-panel tab                                 | `info` (key/value sections), `tasks`, `subagents`   |
| Toolbar buttons, dialogs, commands, a popover     | `models`                                            |
| A status-line action, an entry renderer over core | `self`                                              |
| An extension document in the UI (`useDoc`)        | `plan`, `codemode` (renderers), `models` (`useDoc`) |
| A renderer for your document (Documents tab)      | `plan` (see [Documents](#documents))                |
| Toasts or other global overlays                   | `notices`                                           |

An optional `inbox` renderer wraps each queued composer input with `{ item, core, cancel }`. Return `core` for inputs you do not own; when replacing it, include `cancel` to retain core cancellation. Like entry renderers, the last facet in discovery order wins and runs behind an extension boundary with core fallback. Keep provenance and domain-specific UI in the extension.

An optional `composer` renderer receives `{ core, dock? }` for the shown conversation's composer (`dock` marks a
narrow side region). Render `core` to preserve the existing composer, optionally wrapping it. Facets compose in
discovery order: each receives the previous rendering as `core`, behind its own extension boundary with that rendering
as fallback. These renderers can use `useTranscript()` for the shown conversation's current entries.
Lineage uses this to show a root's read-only History banner, with the way back to @ultimate, instead of a composer.
To send what the composer submits elsewhere, wrap `core` in `<ComposerRedirect to={{ placeholder, send }}>` (from `@/sdk`):
while `to` is set, Enter and the send button call `send(text)` instead of submitting, with the same draft, error and
sending states (side-chat forks @ultimate this way). Only the shown conversation's composer takes typing shortcuts
(Escape, Shift+Tab); a scoped one does not.
`switchConversation(id, { replace: true })` takes the current history entry instead of adding one, as a redirect does.

Wrap `<Conversation/>` in `<ConversationScope id={id}>` (both from `@/sdk`) to render another live conversation without
switching the shell. `useConversation(select?)`, `useTranscript`, `useDoc`/`useDocKind`, `useUltimate().conversationId`,
`useIntro`, `useCompact`/`useCompactQuiet`, and `useAction` follow the nearest scope, as do transcript/composer
contributions. Scopes of the same id share a stream; the last unmount releases it. Outside a scope these hooks keep
their existing behaviour. A shortcut pressed inside a scope runs its command with the scope's id as
`context.conversationId` (Escape stops the scoped run). Explicit `useDocOf` ids, root UI state, shell navigation, the
palette, `getConversation()` without an id and the imperative `api` stay global: callbacks using `api` must pass the
scoped id explicitly when acting on it, as toolbar contributions do with `useConversation().id`.

## Where extensions live

Ultimate looks for extension folders in three places. When two have the same folder name, the later place wins and
replaces the whole extension, both facets:

| Source    | Folder                            | For                                                                |
| --------- | --------------------------------- | ------------------------------------------------------------------ |
| `builtin` | `extensions/` in Ultimate's clone | Ultimate's own features, shipped with it                           |
| `user`    | `~/.ultimate/extensions/`         | Your additions, in every project                                   |
| `project` | `<project>/.ultimate/extensions/` | One project's tools and apps, committed with the project; wins all |

A tool name follows the same layering: a project or user extension may override a built-in's tool (a project `bash`
replaces coding-tools'). Two extensions of the same source may not share one: the one that loaded second fails with
a load error such as `web_search is already provided by parallel`, and takes the name on its next reload once the
other is disabled or removed.

Every extension folder is on by default, built-in, user or project: adding the folder is the opt-in. The exception is
the built-ins listed in `defaultOff` (`shared/extension-api.ts`; see [settings](../docs/settings.md)), which need
something of their own and ship off until `extensions.enable` names them (including `voice-live`, the live voice relay). Turn one off
with `{ "extensions": { "disable": ["hello"] } }` in `~/.ultimate/settings.json` (this machine) or
`<project>/.ultimate/settings.json` (this project), and back on with `extensions.enable`. Settings layer defaults →
machine → project; later layers win. Settings changes apply live without a restart; unknown names produce a notice.
A core-tier extension (`export const tier = 'core'` in its `api.ts`, such as conversations, workspaces, subagents,
lineage, messages and sidebar) stays on whatever the settings say, and depends only on other core-tier extensions: an
optional extension plugs into it through a point or an event, never the other way round (lint `core-tier-deps`; see
[Core tier](../docs/extensions.md#core-tier)).

The `parallel` web tools read their key from `secrets`. Secrets are user-global, not project state.

A server facet may export `secrets: { name: string; description: string; url?: string; provider?: string }[]`. Names must match `^[A-Z][A-Z0-9_]*$`, descriptions must be non-empty, and optional URLs must use http(s). `provider` names a model provider whose configured auth stands in for the secret: the setup check stops reporting it missing once that provider has auth. Installed declarations appear in `ExtensionInfo.server.secrets` and the Secrets panel; values never appear in extension info. Other server facets read values with `readSecret(userHome, name)` from `lib/secrets.ts`; only the secrets extension writes them.

The `tailscale` built-in, once enabled, exposes Ultimate to your own Tailscale login; only user settings set its allowlist. See [tailscale](tailscale/README.md) for stable project URLs and owner-login admission.

The project is the directory Ultimate was started in (`ultimate [dir]`); the Info panel lists every extension with its
source when `info` is enabled; the building-blocks prompt names the clone root. Put a project's app in its `.ultimate/extensions/<name>/`. When the
project is Ultimate itself, that is `.ultimate/extensions/` in the clone, not `extensions/`, which holds the built-ins.

Extensions outside the clone import exactly what built-ins import (`@/sdk`, `@/components/…`, `react`,
`lucide-react`, any package installed in the clone): Ultimate resolves those from its clone, and Tailwind picks up their
classes. In the clone, `pnpm check` type-checks and lints `extensions/` and `.ultimate/extensions/`; extensions of
other projects are not checked by anything, so try them in the browser. Agents live in the same three places
(`agents/`); an enabled extension may also ship an `agents/` folder. Those definitions load as built-ins before
user/project definitions and overlays, and disappear when the extension is disabled. Skills load as [Discovery and settings](../docs/settings.md) describes, later scopes winning by name. A project's `.ultimate/settings.json` may set `defaultSurface` (see
[Surfaces](#surfaces)).

## Extension host

Server factories receive exactly these `ExtensionHost` fields (import its type only from `server/extensions.ts`):

- `ultimateRoot`, `projectRoot`, `userHome`, `home`: source, work, user and instance-state roots.
- `modelRuntime`, `settings`: Pi model/auth runtime and settings.
- `models()`: model descriptors, including availability.
- `skills(cwd)`: merged clone, user and project skills for a working directory, each with its `scope` and `overrides`.
- `restart(approved)`: request a verified core swap; the async callback records the approved generation before activation.
- `build()`, `system()`, `extensions()`: current build, system and extension inspection.
- `conversations()`: every conversation's summary, as `useConversations()` gives the web; empty until the harness is open.
- `harness()`, `uiState(context)`, `doc(kind)`: durable harness, root UI snapshot and exported conversation document token.
- `provide(name, value)`, `use<T>(name)`: publish and look up typed process-local behaviour. Import the provider's contract with `import type`, never its implementation. Registrations are staged until installation succeeds, replaced on reload, and removed when the facet is disabled, removed or closed; a missing provider returns `undefined`. Look up at call time rather than retaining a provider across reloads. A failed replacement keeps the old provider. For example, workspaces provides `WorkspaceService` under `workspaces`; lineage provides `LineageService` under `lineage`. Shared branches and landings work without the other extension; isolated branches require workspaces.
- `implement(api, value)`, `need(api)`, `want(api)`, `catalogue()`: the typed successors of `provide`/`use`; see [Extension APIs](#extension-apis).
- `metadata`: the core's `ultimate.metadata` conversation document, `{ title?, label? }`; the shell names a conversation
  by them, so set them on conversations you create (`subagents` labels each child with its definition).
- `emit(tx, event, data)`, `react(name, events, handler)`, `eventLog`: durable events; see [Events](#events).
- `trace`: the recorded calls (services, actions, reactor runs, tools); see [docs/extensions.md](../docs/extensions.md#tracing).
- `access.allow({ origin, verify })`: register an HTTP origin with an identity verifier; returns a disposer and is automatically removed when the facet unloads or reloads. HTTP, API, and websocket upgrades use the same admission rules.
- `notice(message)`: publish a warning notice and retain it in this facet's system diagnostics for later clients, until unload/reload.
- `resource(key, create)`, `onOpen(callback)`, `onRelease(callback)`, `onClose(cleanup)`: shared reload-stable resources, async work each
  time the harness opens (at once if it is open; the server serves once it settles), async work each time before it closes while the process stays (a core swap; drop commit subscriptions there), and async cleanup. Facet-level callbacks are removed on unload/reload, with cleanup run before the replacement opens. Callbacks registered inside a shared resource's creation belong to that reload-stable resource and survive until server shutdown.
  Keep only process state in a resource (running children, in-flight promises, flags); never capture document or task
  tokens or facet functions in it, since they go stale on reload. Build those on each install around the shared state.

## Extension APIs

Everything an extension offers other extensions on the server lives in its `api.ts`: the service token, the documents
others read and the events it emits (defined in its `refs.ts`, below, and re-exported). It holds only contracts and is
documented, because agents discover APIs by reading these files:

```ts
/** Echo: says text back. Other extensions use it to test a round trip. */
import { defineApi } from '../../shared/extension-api.ts'

export type EchoService = {
  /** Return `text` unchanged; use it to check that echo is reachable. */
  echo(text: string): string
}
/** The echo service; `want` it, echo is optional. */
export const Echo = defineApi<EchoService>()('echo')
export { Echoed } from './refs.ts'
```

Lint holds every `extensions/*/api.ts` to that shape (`ultimate/api-file-shape`, `ultimate/api-naming`; see
[docs/extensions.md](../docs/extensions.md#extension-apis)), and a server-side `.ts` file may import another
extension's runtime code only from its `api.ts` (`ultimate/api-only-imports`); type imports are free.

### The browser side: `refs.ts` and `ui.tsx`

`api.ts` describes server code and may reach it through type imports, so the browser never imports it. An extension
whose documents or actions the browser uses describes them in `refs.ts`, browser-safe and documented like `api.ts`:
every action ref names its arguments and result, since agents read it to call the action with `ultimate.action`.

```ts
/** Echo in the browser: the echo log, the action that echoes and its event. Browser-safe. */
import { actionRef, docRef } from '../../shared/extension-api.ts'
import { defineEvent } from '../../shared/events.ts'

/** The echo log on conversation 1. */
export const LogDoc = docRef<{ texts: string[] }>('echo.log')
/** `{ text }` → `{ at }`: echo `text` and log it. */
export const EchoAction = actionRef<{ text: string }, { at: number }>('echo', 'echo')
/** Text was echoed; react to it to count echoes. */
export const Echoed = defineEvent<{ text: string }>('echo.echoed')
```

The web reads and calls through the refs, typed: `useDoc(LogDoc)`, `useDocOf(1, LogDoc)`, `useAction(EchoAction,
args)`, `api.action(EchoAction, args)`. The server ties itself to the same refs: its `defineDoc` uses
`kind: LogDoc.kind`, and each handler is `implementAction(Ref, handler)` from `lib/actions.ts`, which fails the type
check when the handler's result is not the ref's or it reads an argument the ref does not name:

```ts
export const actions = {
  echo: implementAction(EchoAction, async (args, ctx) => {
    const text = args && typeof args === 'object' && !Array.isArray(args) ? args.text : undefined
    if (typeof text !== 'string') throw new Error('Expected { text }')
    return { at: await log(ctx.host, text) }
  }),
}
```

`test/refs.test.ts` holds every action ref to an `implementAction` of that ref in its extension's `actions`, and
every doc ref to a kind some server facet's `docs` exports. What other extensions' browser code uses (shared components, hooks and the refs they need) is exported from the
owner's `ui.tsx`, which starts with a doc comment on what it offers. A `.tsx` file imports another extension at
runtime only from its `ui.tsx`, and its `api.ts` or `refs.ts` only as types (`ultimate/api-only-imports`). `refs.ts`
imports at runtime only `shared/`, and types only from packages, `shared/` and extensions' `refs.ts` or `types.ts`;
it is part of the web type check (`tsconfig.web.json`).

A lower extension whose browser code shows something a higher one knows (a phase label on a sidebar row) declares a
**point** in its `ui.tsx` and renders it with a render prop; the higher extension provides the value from its
`web.tsx`, so the lower one imports nothing of it:

```tsx
// conversations/ui.tsx
export const Phase = definePoint<number, { word: string } | undefined>('conversations.phase')
// a row: <Provided point={Phase} input={id}>{(phase) => phase && <span>{phase.word}</span>}</Provided>
// phase/web.tsx
export default defineWebExtension({ provides: [provide(Phase, (id) => usePhaseWord(id))] })
```

The provider's function is a hook, run once per `<Provided>`; the last facet in discovery order providing a point wins,
and while none does the render prop gets `undefined`. A point that combines its providers (the sidebar's rows under
@ultimate) renders `<AllProvided point input>{(values) => …}</AllProvided>` instead: every provider's value in discovery
order, a throwing one left out behind its inline error card. The web core declares its own points in the SDK: `ParkedRuns`
(pause), `RunStart` (tasks), `ConversationKind` (the title bar's kind before a title; messages names coordinator
branches `branch · coordinator`) and `MessageReference` (the copyable reference to a stored message; codemode). The server's counterpart is an extension point
([docs/extensions.md](../docs/extensions.md#extension-apis)).

The provider calls `host.implement(Echo, { echo: (text) => text })` in its factory; it is staged, replaced and
removed with its facet. A consumer calls `host.need(Echo)` for a hard dependency or `host.want(Echo)` for an
optional one. Both return a handle typed by the token that resolves the current provider on every member access, so
holding it from setup is fine. `need` throws `<ext> needs echo, which no enabled extension provides` while nothing
provides it; called during setup it records the dependency instead (the provider may load later) and a still-missing
provider becomes an extension diagnostic. `want` returns undefined while missing, so call it where you use it. The core
tier is always on, so its services are always `need`ed; `want` is for optional extensions and extension points.
`host.catalogue()` (codemode: `ultimate.catalogue()`) lists each API's provider, needs and wants, plus missing
providers and dependency cycles, each a sorted group of extensions that depend on each other in a cycle.

Which channel to use: services for calls between extensions; documents for durable state; durable events for "this
happened" (`host.emit` in your commit, `host.react` to act on it; see
[docs/extensions.md](../docs/extensions.md#durable-events)); actions for the UI and user boundary. Extensions never call the untyped `host.provide` and `host.use`
(`ultimate/no-raw-services`).

## Lifecycle

Facet-registered `onOpen` and `onClose` callbacks are facet-scoped: they end on reload, disable, or unload. An `onOpen` registered after installation while the harness is already open runs immediately. Cleanup failures produce notices and do not stop the remaining facet cleanups. Callbacks registered synchronously inside a `resource()` factory are process-scoped and survive reloads until server shutdown. Process-scoped cleanups settle independently; failures produce notices without preventing core shutdown.

A server facet can export `reloadOnSettings = true` to reinstall on live settings changes even when its enablement is unchanged. Its scoped lifecycle callbacks and access registrations are cleaned up before its replacement opens.

Type imports from `server/` are fine. Runtime imports need a host capability or a visible lint exception.

## Events

On the server, "something happened" is a durable event whose token the emitter defines in its `refs.ts` and
re-exports from `api.ts` and `ui.tsx` (see Extension APIs). The browser
has an ephemeral `events` bus from `@/sdk`: it queues and replays nothing, catches and logs handler errors with the
channel while other handlers continue, and `on(channel, handler)` returns an unsubscribe; clean it up when its owner
is removed.

Name channels `<extension>:<event>`; `ultimate:*` is reserved for the core. In a web component, use
`useEvent(channel, handler)` to subscribe for its mount and always call the latest handler:

```tsx
import { events, useEvent, useReady } from '@/sdk'

function Receiver() {
  useEvent('hello:selected', (data) => console.log(data))
  const { ready, timedOut, failed, pending } = useReady()
  return (
    <span>
      {ready ? 'Ready' : 'Loading'} {failed.join(', ')}
      {timedOut && `Still loading: ${pending.join(', ')}`}
    </span>
  )
}
// From another facet:
events.emit('hello:selected', { name: 'example' })
```

The registry emits `ultimate:extension-loaded { name }` or `ultimate:extension-failed { name, error }` as each
facet settles, including hot reloads. `ultimate:ready { failed, pending, timedOut }` fires once per page load when
the current loader generation has settled (loaded or failed) and the first system snapshot has arrived, or after
an 8 s deadline from the first loader map. Superseded imports do not determine readiness. `useReady()` returns
`{ ready, timedOut, failed, pending }`, even for a subscriber mounted after the event. `ready` and `timedOut` stay
sticky across hot reloads; `failed` names current load failures and `pending` names current unsettled imports.
The deadline reveals even without a system snapshot; `timedOut` distinguishes that reveal from normal readiness.
Facets import in parallel and their contributions render as soon as they install, except the app itself: the shell
shows the surface and starts its shortcuts only once ready. In particular, root overlays can render while another
facet is still loading; they need not wait for ready.
A reload of a rendered page (a core restart, a Vite full reload, F5) paints the previous page's view from
`sessionStorage` before any module loads and fades it out once the app has rendered and settled
(`web/src/sdk/resume.ts`); `resumed` from `@/sdk` is true on such a load, so a loading overlay can stay away.

## An extension's files

An extension is a folder `<name>/` in one of those places:

| File        | Facet                                                                                                   | Goes live                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `server.ts` | Agent and server: a Pi Durable extension (tools, prompt sections, hooks, documents) and its `actions`   | Reinstalled on save; running tool calls finish on old code |
| `web.tsx`   | UI: `export default defineWebExtension({ … })`                                                          | Vite hot reload, no page reload                            |
| `README.md` | What it does; the first paragraph is shown in the UI, so open with a sentence, not a heading. Required. | Read on change                                             |

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

## Contributions

`defineWebExtension({ slots, panels, surfaces, tools, toolLines, entries, link, messageActions, messageDetails, answerLabels, userBubble, compact, intro, documents, commands })`; every key is optional. Extensions load
in parallel, installing independently; contributions follow discovery order: built-in → user → project, then folder name within each source. Give a slot item `{ component, order }` to move it (default order 0, lower first).

### Slots

Components mounted in named places of the shell, on every surface that renders the primitive holding them, and in the
title bar the host shows above every surface.

| Slot                   | Where                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| `sidebar`              | Left column (`<Sidebar />`); it disappears while nothing is in it                                            |
| `sidebar.top`          | Agent sidebar, after the Agents group and before the roots: background work such as watches                  |
| `titlebar.brand`       | Title bar, the wordmark beyond a phone; render `Wordmark` from `@/sdk` with an `onClick`                     |
| `titlebar.project`     | Title bar, in place of the project chip; render `ProjectChip` from `@/sdk` with a menu                       |
| `titlebar.left`        | Title bar above every surface, after the project chip; monospace, one line                                   |
| `titlebar.right`       | Title bar, right, before the palette button                                                                  |
| `header.right`         | Right side of the header, before the panel toggle (`<Header>`)                                               |
| `statusline.left`      | Bottom status line, left; monospace, one line (`<StatusLine />`)                                             |
| `statusline.right`     | Bottom status line, right (`<StatusLine />`); on a phone only `phone: true` items stay, the rest go behind ⋯ |
| `composer.toolbar`     | Left of the composer's footer; a size container, condense with `@max-md:` (`<Conversation />`)               |
| `composer.status`      | Line under the composer; conversation-specific, monospace, one line (`<Conversation />`)                     |
| `composer.actions`     | Composer footer, beside Send; input helpers that write into the draft with `insertIntoComposer`              |
| `conversation.overlay` | Over the transcript and the composer (`<Conversation />`); position it `absolute inset-0`                    |
| `transcript.start`     | Above a transcript's first row once its whole history is loaded; `useTranscript()` inside                    |
| `transcript.end`       | After a transcript's last row, before the working line: a turn still forming, such as live speech            |
| `overlay`              | Always mounted at the root, above every surface: dialogs, toasts, global effects                             |
| `shell.rail`           | Full-height column at the window's left edge, beside the title bar and every surface; not in a frame         |

```tsx
slots: { 'header.right': [Badge], sidebar: { component: Conversations, order: -1 } }
```

Contextual commands can receive an `entryId` alongside `conversationId` through `useCommands()`; a message-action
component can pass its entry's id to a command.

### Panels

Tabs of the right panel (toggle: `mod+alt+b`).

```tsx
import { InfoIcon } from 'lucide-react'
panels: [{ id: 'info', title: 'Info', icon: InfoIcon, component: InfoPanel }]
```

Open one from code with `useUltimate().openPanel('info')`. A panel with `tab: false` stays out of the tab row until
something opens it (a command, a sidebar row); give it a ⌘K command. Panels show on surfaces that render `<Panels />`, such
as Agent.

### Surfaces (apps)

Full-screen apps the user switches between, with the agent one keystroke away; [Surfaces](#surfaces) below explains
them, with the primitives and a complete example.

```tsx
surfaces: [{ id: 'commits', title: 'Commits', icon: GitCommitHorizontalIcon, component: Commits }]
```

### Tool renderers

How a tool call looks in the transcript, by tool name. Without one, a generic card shows name, arguments, and output.

```tsx
import { Tool, ToolContent, ToolHeader, ToolOutput } from '@/components/ai/tool'
import type { ToolCallView } from '@/sdk'

function Grep({ call }: { call: ToolCallView }) {
  return (
    <Tool>
      <ToolHeader name="grep" state={call.status} title={String(call.args.pattern ?? '')} />
      <ToolContent>
        <ToolOutput output={call.output} isError={call.status === 'error'} />
      </ToolContent>
    </Tool>
  )
}
tools: {
  grep: Grep
}
```

`ToolCallView`: `id`, `name`, `args` (partial while the model streams them), `status` (`streaming`, `pending`,
`running`, `done`, `error`, `interrupted`), `output` (streamed while running, the result's text when done), `images`
(the result's images, such as screenshots), `details` (the tool's `details()`; cast to its shape), `diagnostics`,
`dropped`, `startedAt`/`endedAt`, and `result`. `useToolDuration(call)` gives a ticking duration. `ToolImages` (or one
`ToolImage`) from `@/components/ai/tool` shows images as thumbnails that open full size; the generic card already does.
To put a button beside the header (such as "open"), wrap `ToolHeader` in a flex row inside `Tool`: a button inside the
header would toggle it.

Tool renderers also receive `core`, starting with the generic tool card. Like entry renderers, they compose in
discovery order (built-in → user → project): each receives the previous rendering, and its error boundary falls back
to that rendering. Return `core` to leave it unchanged, wrap it to decorate it, or replace it with your own card.

### Link renderers

`link` renders the links in Markdown that `MessageResponse` shows (messages, reports). It receives `{ href, children,
core }`; `core` starts as Streamdown's link, which asks "Open external link?" before opening a new tab. Like tool
renderers, link renderers compose in discovery order behind error boundaries that fall back to `core`: return `core`
for links you leave alone. A link still streaming never reaches them. `instance` renders links to its previews as chips
that open in the window. `MessageResponse` also turns `#id` and `#id/entry` mentions (three or more digits, outside
code and links) into `#conversation-<id>[-<entry>]` links, and `MentionText` does the same for plain text;
`conversations` renders those of known conversations as their feature chip, others stay text.

```tsx
link: ({ href, children, core }) =>
  href.startsWith('https://docs.example.com/') ? <a href={href}>{children}</a> : core
```

### Code block renderers

`codeBlocks` renders the fenced code blocks of one language in Markdown that `MessageResponse` shows, keyed by the
fence's language. Each receives `{ code, language, incomplete, core }`; `core` starts as the highlighted block with its
copy button, and `incomplete` is true while the fence still streams. They compose in discovery order behind error
boundaries that fall back to `core`. Return `core` while `incomplete`, so a half-written block never renders.

```tsx
codeBlocks: {
  dot: ({ code, incomplete, core }) => (incomplete ? core : <Graph source={code} />),
}
```

Fenced `mermaid` blocks already render as diagrams in the page's theme (Streamdown's diagram support, with Mermaid
loaded when a message first shows one); a chart that does not parse, or not yet, stays its highlighted code. A
`codeBlocks` renderer for `mermaid` takes over from it.

### Message actions

`messageActions` contributes components to the hover action row on stored user and assistant messages, between the
copy-message and copy-reference buttons. Each receives `{ entry }`, follows discovery order (then array order), and
runs in its own error boundary. Return `null` for messages you do not act on. Keep buttons compact and give them an
accessible label and a tooltip.

```tsx
messageActions: [
  ({ entry }) => (
    <button
      aria-label="Pin message"
      title="Pin message"
      onClick={() => pin(entry.id)}
      type="button"
    >
      <PinIcon className="size-3" />
    </button>
  ),
]
```

`messageDetails` contributes readouts to the same row, before the message's time, under the same rules. `status-line`
shows each message's context and cost there.

`answerLabels` contributes inline labels after the **Final answer** heading, only on stored final assistant messages
(not streaming updates). Like `messageDetails`, it is an array of components receiving `{ entry: EntryRecord }`,
rendered in discovery and contribution order, each behind an extension boundary. Return `null` when the entry has
no relevant label. Keep labels brief and muted; the header wraps at narrow widths. Messages uses it to show where an
answer was sent, or that a one-way message's answer was not sent.

`userBubble` contributes overlays on the user's own bubble: components receiving `{ entry }`, rendered after the
bubble inside a positioned box exactly its size, so an `absolute inset-0` element decorates it. Return `null` when
there is nothing to show. Recall uses it for the light running around a message's border while it checks it.

`toolLines` maps tool names to components receiving `{ call: ToolCallView }` that render the call as one short line
of plain text. A folded "worked · N steps" row lists its newest calls this way under its header (a status icon and the
line, the tool name when no facet provides one); the last facet providing a name wins. Coding tools give their verb and
path or programs, codemode its one-line summary.

`compact` makes conversations use compact mode: `{ when(conversation, docs), tools? }` decides from a conversation's
summary and the root conversation's documents, and in a matching transcript each run of tool calls and thinking
between inputs, messages and answers folds into one quiet "worked · N steps" row that expands to the usual rendering.
Calls the listed `tools` keep stay visible and split the run: a tool name, or a test `(call, docs) => boolean` of a
call; `docs` lists the kinds of the root conversation's documents `when` and the tests read, which the transcript
follows and passes to them by kind. The tools of every matching facet combine. Renderers check `useCompact()`, that
test for the shown conversation or `undefined`, to adapt to it. Messages turns it on for @ultimate's conversation, found
by the standing agents' index (`StandingDoc`) rather than its title, keeping messages, branch starts,
workspace outcomes and scripts its log says messaged you, and shows its messages to you as bubbles. Revealing an entry
in a folded run opens the run.

`intro` says what a matching conversation is before its first message: `{ when(conversation), title, hint?, placeholder?, card? }`
replaces the empty state's line under ULTIMATE, adds a hint below it, and sets the composer's placeholder while it is
idle; `card`, a component, renders under the empty state, such as a setup card the conversation needs first. The last
matching facet wins.

### Entry renderers

How an entry kind looks in the transcript. Extensions that append their own entries render them here; a renderer for a
`pi.*` kind takes over from the core one. Unknown kinds show as JSON.

```tsx
entries: { 'notes.pinned': ({ entry }) => <div className="text-muted-foreground">📌 {String(entry.data)}</div> }
```

A renderer also gets `core`, the rendering of the same entry so far: return it for the entries you leave alone, wrap
it, or return `null` to hide the entry. In compact mode, a row can show only some content blocks of a response; `blocks`
lists their indexes then. Several extensions can render one kind: they compose in discovery order, each
receiving the rendering of the one before it as `core`, down to the core's own. Each runs in its own error boundary,
which falls back to its `core` when it throws. `self` renders `pi.system` entries that change the build section as a
reload marker and returns `core` for the rest; `subagents` and `workspaces` both render `pi.user`, each only the inputs
it owns (agent messages, lander reports).

Entry renderers and message contributions relate an entry to its neighbours with `useTranscript()`: the entries the
transcript has loaded, oldest first, which grows as the reader pages in earlier history. `models` marks a response that
ran on another model or thinking level than the one before it this way.

### Documents

Extension documents are durable state on a conversation: a ledger, a store, login flows. The Documents tab
(the `documents` extension) lists every kind the server facets export for the shown conversation and shows each through
the renderer a web facet registers for it, or as a JSON tree without one. To give yours a view:

1. Export the document from `server.ts`: `export const docs = [Plan]`, conversation-scoped tokens from `defineDoc`.
   The Info panel then lists the kind under the extension.
2. Register a renderer in `web.tsx`. It receives the live `value` and the shown `conversationId`; cast the value to
   your document's shape.

```tsx
import { ClipboardListIcon } from 'lucide-react'
import { defineWebExtension } from '@/sdk'
import type { DocumentProps } from '@/sdk'

function PlanDocument({ value }: DocumentProps) {
  const plan = value as unknown as { epics: Record<string, { title: string }> }
  return Object.values(plan.epics).map((epic) => <p key={epic.title}>{epic.title}</p>)
}

export default defineWebExtension({
  documents: [
    { kind: 'ultimate.plan', title: 'Plan', icon: ClipboardListIcon, component: PlanDocument },
  ],
})
```

A later facet in discovery order wins a kind. A renderer that throws shows an error card with the JSON tree below it;
the other documents keep working. To render another extension's component yourself, wrap it in `ExtensionBoundary`
from `@/sdk`, as the Documents tab does, and look renderers up with `useDocumentRenderers()`. Opening the tab streams
every exported kind, which creates a missing document with its initial value, as `useDoc` does.

### Commands

Entries of the command palette (`mod+k`), optionally with a shortcut. `mod` is ⌘ on macOS and Ctrl elsewhere. Most
commands need none: the palette finds them by title. A sequence such as `mod+k m` runs when `m` follows the palette
shortcut, which takes that letter away from palette search (typing "models" would run it), so use sequences only for
something you reach for constantly.

```tsx
commands: [
  { id: 'hello.compact', title: 'Compact now', keys: 'mod+shift+c', run: () => api.compact() },
]
```

`run(context)` gets the shell actions (below), the shown `conversationId` (the scoped one for a shortcut typed inside a
`ConversationScope`), and the shown `surface` id; return a promise
to have a failure reported as a notice. `when(context)` hides the command when it returns false, such as
`when: (context) => context.surface === 'commits'` for a command of one surface; a `when` that throws hides it too and
reports a notice naming your extension. Commands run outside React: read the current state with
`getConversation(context.conversationId)` and `getState()`, not hooks, and act on `context.conversationId`.

Plain keys and Shift+letter never fire while the user types; chords with `mod`, `alt`, or `ctrl` do. A plain key that
must work in the composer too sets `whileTyping: true`, as Escape (`agent.stop`) and Shift+Tab
(`model.thinking.cycle`) do; it fires while the user types in the composer, not in other inputs, and still leaves the
key to an open dialog, which closes or moves focus with it. To let a command open UI an extension renders, such as a
popover, use a dialog id: the command calls `context.open(id)` and the component reads `useDialog(id)` as its open state
(see `models`).

Command ids are global and resolve like surface ids: a later facet in discovery order wins an id, in the place of the
command it replaces. The shell itself has only the palette (`ultimate.palette`), the panel and sidebar toggles
(`ultimate.panel`, `ultimate.sidebar`), and a `ultimate.surface.<id>` switch per surface; the conversation commands
(stop, compact, focus the composer, show the main conversation) come from `agent`, the theme toggle from `theme`. To
replace one, declare its id; to drop it, replace or delete its extension.

## Actions

A web facet runs in the browser; its server facet runs in Ultimate's Node process, next to the project's files, its
command-line tools, and the network. Actions connect the two: `server.ts` exports `actions`, plain async functions, and
the UI calls them through a typed ref, JSON in and JSON out.

```ts
// server.ts
import type { JsonValue } from '@earendil-works/chord'
import { defineExtension } from '@earendil-works/pi-durable'
import type { ActionContext } from '../../../server/actions.ts'

export default defineExtension({ name: 'todos' })

export const actions = {
  async list(_args: JsonValue, ctx: ActionContext) {
    const { stdout } = await ctx.exec('git', ['grep', '-n', 'TODO'])
    return stdout.split('\n').filter(Boolean)
  },
}
```

```tsx
// web.tsx
import { actionRef, useAction } from '@/sdk'

/** No arguments → every `TODO` line as `file:line:text`. */
const ListAction = actionRef<null, string[]>('todos', 'list')

const todos = useAction(ListAction)
// todos.data, todos.error, todos.loading, todos.refetch()
```

An action is `(args, ctx)`; `ctx` has:

| Field                                     | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `exec(command, args, { cwd?, timeout? })` | Runs a program without a shell, in the conversation's freshly admitted workspace/cwd when `conversationId` is supplied, otherwise the project root; explicit `cwd` overrides it. Each conversation-aware execution fails closed on workspace preparation/discard/lifecycle state and reserves execution until exit. Read-only or lifecycle actions that do not call `exec` remain callable. Resolves `{ stdout, stderr }`; rejects on a non-zero exit, after `timeout` (default and maximum 30 s), or past 1 MiB of output. |
| `signal`                                  | Aborted when the UI stops waiting (a newer call, an unmount, a closed tab); `exec` honours it. Pass it on to your own `fetch`.                                                                                                                                                                                                                                                                                                                                                                                              |
| `conversationId`                          | The conversation the UI showed when it called.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `host`                                    | The extension host: `projectRoot`, `ultimateRoot`, `system()`, `uiState(context)`, `harness()`, and more (see `AGENTS.md`).                                                                                                                                                                                                                                                                                                                                                                                                 |

The `ActionContext` import is type-only. The path above is right for `.ultimate/extensions/<name>/` in Ultimate's clone
(built-ins use `../../server/actions.ts`); in another project nothing type-checks it and the import is erased, so it
runs either way. A project extension keeps its refs in `web.tsx`, from `@/sdk`; built-ins keep them in `refs.ts` and
check their handlers against them with `implementAction` (see [Extension APIs](#the-browser-side-refsts-and-uitsx)).

- **Arguments are untrusted, from the browser or an agent**: make actions safe to call from an agent and validate args before they reach a command line. `exec` takes an argument list,
  never a shell string, so quoting is never the problem; meaning is.
- **Return small JSON shaped for the UI**, not raw command output. Ask CLIs for JSON (`gh … --json`) and limit how much
  they return.
- **Throw clear messages; return states as data.** A thrown error's message, up to 500 characters, reaches the UI as
  `error.message` and in the notice (`todos/list: <message>`, HTTP 500); the whole error goes to the server log. Throw
  for faults, with a message that says what went wrong. Return states the user should see and act on as data instead,
  such as `{ status: 'setup', reason: 'gh is not installed' }`, and render them as a screen of their own.
- **Live**: saving `server.ts` reinstalls it and the next call runs the new code. No restart.
- **Quick**: an action holds a request open, and `exec` stops at 30 s. Hand long work to the agent (`api.submit`).

Call actions from the UI in one of two ways:

- `useAction(ref, args?, { enabled?, onError? })` reads. It calls on mount and again whenever the action or `args`
  (compared as JSON) change, unless `enabled` is false; a newer call aborts the older one. It returns
  `{ data, error, loading, refetch }`: `data` stays while a refetch runs and resets when the args change; `refetch()`
  calls again, also when not `enabled`. A failure shows as a notice unless you pass `onError`.
- `api.action(ref, args?, { conversationId?, signal?, keepalive? })` acts, once: a click that saves,
  closes, or labels something; `keepalive` lets a call sent on `pagehide` outlive the page. It returns a promise of
  the result; afterwards, `refetch()` what changed. A rejection (an `ActionError` with `extension`, `action`,
  `status`, `message`) that nothing catches shows as a notice; catch it to handle it yourself.

```tsx
<Button
  onClick={async () => {
    await api.action(ResolveAction, { line })
    await todos.refetch()
  }}
>
  Resolve
</Button>
```

Agents call actions in codemode with `await ultimate.action('todos', 'list', args)`, returning the result directly
or throwing the action's error. Calls run in-process on behalf of the calling conversation, with the sandbox abort
signal; omitted args become null. `ultimate.extensions()` lists actions; document their args in your README.

A server facet may export `userActions: string[]` alongside `actions` to reserve named actions for the UI.
Every name must refer to a registered action; invalid declarations fail facet installation. Use this for choices
only the user should make, such as granting project trust, managing secrets, or logging in to providers:

```ts
export const userActions = ['decide']
```

Codemode rejects these calls with `<extension>/<action> is a user-only action`; the HTTP path still calls them.

Likewise `pollActions: string[]` names read-only actions a surface polls with changing arguments (cursors, windows):
the call trace counts their successful calls in `host.trace.polls()` instead of writing them, with the plain action
and service calls they make; a failure, a model call or a tool call under one is written with the chain above it.
This is an explicit opt-out from agent action dispatch, not a security sandbox against arbitrary agent code.

The HTTP endpoint remains browser-only: requests require `Sec-Fetch-Site: same-origin` or a loopback `Origin`
matching the server's port. A plain agent `curl` receives 403; use `ultimate.action` instead of forging browser headers.

## Surfaces

The window shows one surface at a time. **Agent** is the built-in home surface (`extensions/agent`): the conversation
with the sidebar and the right panel. An app surface puts its own UI first and keeps the agent one keystroke away,
usually docked beside it. The `documents` extension provides the Documents tab.

- **Switching**: the title bar lists the surfaces as tabs (Agent first, then by `order`, then title); on phones the brand
  opens them as a menu. ⌘K has "Switch to …"; `mod+1…9` select the first nine (Ctrl+1…9 off macOS, which Chrome lets
  the page take before its tab switching). In code: `useUltimate().showSurface(id)` or
  `context.showSurface(id)` in a command. Switching never interrupts the agent: the run goes on, and the transcript and
  the composer's draft are where they were.
- **Durable**: the choice is UI state `shell.surface`; it survives reloads and restarts and follows every tab. Until the
  user picks one, a project's `.ultimate/settings.json` (`{ "defaultSurface": "commits" }`) chooses, if that surface
  is installed.
- **Failure**: if the chosen surface is not installed, or its component throws, Agent shows instead, with a notice; a
  fixed version comes back on its own. If even Agent fails, a bare header, conversation, and status line remain. The
  window title and `surface` below name what is on screen, so Agent while it stands in.
- `useUltimate().surface` and `context.surface` give the id of the surface on screen.

The contribution:

| Field         | Meaning                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------- |
| `id`          | Global and stored in `shell.surface`: use the extension name (`commits`) or prefix it (`commits.graph`) |
| `title`       | Shown in the switcher, the title bar, ⌘K, and the window title                                          |
| `icon`        | A `lucide-react` icon                                                                                   |
| `description` | One line under the title in the switcher                                                                |
| `order`       | Position after Agent; lower first (default 0), then by title. It decides which `mod+<n>` selects it     |
| `component`   | The surface itself                                                                                      |

### Layout

The host renders the surface inside a column that fills the window (`flex h-dvh flex-col`), under its title bar: the
brand, the project, the surfaces, and the palette button (none when Ultimate is embedded in an iframe).
Compose the surface top to bottom, and make the middle row `flex min-h-0 flex-1` so it takes the rest and scrolls
inside, not the page:

```tsx
function MyApp() {
  return (
    <>
      <Header />
      <div className="flex min-h-0 flex-1">
        {/* your columns; a scrolling one gets min-h-0 (or min-w-0) and overflow-y-auto */}
        <Dock>
          <Conversation variant="dock" />
        </Dock>
      </div>
      <StatusLine />
    </>
  )
}
```

### Primitives

Import them from `@/sdk`. Each is a thin wrapper over the shell's own parts; the Agent surface is nothing but these.

| Primitive                                 | What it renders                                                                                                                                                                                                                                                                                     |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<Header>`                                | The surface's top bar: its children (by default the shown conversation's trail) and the `header.right` slot. It adds the sidebar and panel toggles when the surface renders them.                                                                                                                   |
| `<StatusLine />`                          | The bottom line with the `statusline.left` and `statusline.right` slots                                                                                                                                                                                                                             |
| `<Conversation variant="main" \| "dock">` | The shown conversation: transcript and composer, filling their box. `main` centres a reading column; `dock` fits a narrow region.                                                                                                                                                                   |
| `<Dock title? side?>`                     | A collapsible, resizable side region, `right` by default; `title` (default `conversation`) labels it. Drag the inner edge to resize, double-click it to reset. Collapsed, it is a rail that pulses while the agent works. Open state and width persist per surface (`shell.dock.<surface>.<side>`). |
| `<Sidebar />`                             | The `sidebar` slot as a left column, toggled with `mod+b`; nothing while the slot is empty                                                                                                                                                                                                          |
| `<Panels />`                              | The right panel with every extension's panel tabs, toggled with `mod+alt+b`                                                                                                                                                                                                                         |
| `<Slot name variant? />`                  | Any slot by name, each item in its own error boundary; `variant="inline"` for one-line places                                                                                                                                                                                                       |

Everything else on a surface is your own components, styled like the rest of Ultimate (see [Styling](#styling)).
A transcript card (a subagent report, a message, a catch-up) is a `<Card>`: a bordered section with the brand accent on
its left edge; `className` adds layout, such as padding or `overflow-hidden`.
Pass the header your own title or controls as children: `<Header><span className="text-[13px]">12 open</span></Header>`.

### Example: a Commits app

A complete app: the project's recent commits in a list, the selected one beside it with a button that hands it to the
agent, and the agent docked on the right. It needs nothing but `git`. Put the three files in
`<project>/.ultimate/extensions/commits/`; on save, Commits appears in the switcher (`mod+2`).

`server.ts`, the data:

```ts
import type { JsonValue } from '@earendil-works/chord'
import { defineExtension } from '@earendil-works/pi-durable'
import type { ActionContext } from '../../../server/actions.ts'

export default defineExtension({ name: 'commits' })

/** The UI calls these through the refs in `web.tsx`; each returns JSON. */
export const actions = {
  /** The latest 50 commits of the project. */
  async list(_args: JsonValue, ctx: ActionContext) {
    const format = '--format=%H%x1f%s%x1f%an%x1f%ar'
    const { stdout } = await ctx.exec('git', ['log', '-n', '50', format])
    return stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [sha, subject, author, when] = line.split('\x1f')
        return { sha, subject, author, when }
      })
  },
  /** One commit: its message and the files it changed. */
  async show(sha: JsonValue, ctx: ActionContext) {
    if (typeof sha !== 'string' || !/^[0-9a-f]{7,40}$/.test(sha)) throw new Error('Expected a sha')
    const { stdout } = await ctx.exec('git', ['show', '--stat', '--format=%B', sha])
    return { sha, text: stdout.trim() }
  },
}
```

`web.tsx`, the surface:

```tsx
import { GitCommitHorizontalIcon, MessageSquarePlusIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Conversation,
  Dock,
  Header,
  StatusLine,
  actionRef,
  api,
  cn,
  defineWebExtension,
  useAction,
  useExtensionUiState,
} from '@/sdk'

type Commit = { sha: string; subject: string; author: string; when: string }

/** The actions of `server.ts`, typed: no arguments → the latest 50 commits; a sha → its message and files. */
const ListAction = actionRef<null, Commit[]>('commits', 'list')
const ShowAction = actionRef<string, { sha: string; text: string }>('commits', 'show')

/** One commit, and a button that hands it to the agent. */
function Detail({ sha, text }: { sha: string; text: string }) {
  return (
    <>
      <div className="flex items-center gap-3">
        <h1 className="font-mono text-[13px] text-muted-foreground">{sha.slice(0, 12)}</h1>
        <Button
          className="ml-auto"
          onClick={() => void api.submit(`Review commit ${sha}.`, 'followUp')}
          size="sm"
          variant="outline"
        >
          <MessageSquarePlusIcon />
          Ask the agent
        </Button>
      </div>
      <pre className="mt-4 font-mono text-[12px] whitespace-pre-wrap text-foreground/90">
        {text}
      </pre>
    </>
  )
}

/** Recent commits on the left, the selected one in the middle, the agent docked on the right. */
function Commits() {
  const commits = useAction(ListAction)
  const [selected, setSelected] = useExtensionUiState<string | null>('selected', null)
  const sha = selected ?? commits.data?.[0]?.sha ?? null
  const commit = useAction(ShowAction, sha ?? '', { enabled: sha !== null })
  return (
    <>
      <Header />
      <div className="flex min-h-0 flex-1">
        <nav className="w-72 shrink-0 overflow-y-auto border-r border-border/70 bg-sidebar py-1">
          {commits.loading && !commits.data && (
            <p className="px-3 py-2 font-mono text-[12px] text-muted-foreground">loading…</p>
          )}
          {commits.data?.map((item) => (
            <button
              className={cn(
                'block w-full px-3 py-1.5 text-left hover:bg-accent/60',
                item.sha === sha && 'bg-accent',
              )}
              key={item.sha}
              onClick={() => setSelected(item.sha)}
              type="button"
            >
              <span className="block truncate text-[13px]">{item.subject}</span>
              <span className="block font-mono text-[11px] text-muted-foreground">
                {item.sha.slice(0, 7)} · {item.author} · {item.when}
              </span>
            </button>
          ))}
        </nav>
        <main className="min-w-0 flex-1 overflow-y-auto px-6 py-5">
          {commit.data && <Detail {...commit.data} />}
        </main>
        <Dock>
          <Conversation variant="dock" />
        </Dock>
      </div>
      <StatusLine />
    </>
  )
}

export default defineWebExtension({
  surfaces: [
    {
      id: 'commits',
      title: 'Commits',
      icon: GitCommitHorizontalIcon,
      description: 'Recent commits; hand one to the agent',
      component: Commits,
    },
  ],
})
```

`README.md`:

```md
Browse the project's recent commits and hand one to the agent.
```

What it shows: `useAction` loads the list on mount and the detail whenever the selection changes (disabled until there
is one); the selection lives in `useExtensionUiState`, so it survives reloads; `api.submit(text, 'followUp')` sends a
message to the shown conversation, queued as a follow-up if the agent is busy, and the dock shows it arrive.

### Build an app, step by step

For a request such as "build a triage surface for this repo's GitHub issues":

1. **Place it.** One folder, `<project>/.ultimate/extensions/<name>/` (in Ultimate's own repository:
   `.ultimate/extensions/<name>/`). The surface id is `<name>`.
2. **Find the data first.** Run the commands in a shell (`gh issue list --limit 50 --json number,title,labels`), prefer
   JSON output and bounded results, and find out what happens when the tool is missing or logged out.
3. **Write `server.ts`**: `defineExtension({ name })` and `actions` that wrap those commands with `ctx.exec`, validate
   their args, and return small JSON shaped for the UI. Return setup states (missing tool, no login, no repository)
   as data, so the UI can say what to do.
4. **Check each action with codemode `ultimate.action`** (see [Actions](#actions)) before any UI exists.
5. **Write `web.tsx`** from the Commits example: a typed ref per action; keep `Header`, `Dock`
   with `Conversation variant="dock"`, and `StatusLine`; replace the list and the detail. Read with `useAction`, act with `api.action` then `refetch`, keep
   the selection and filters in `useExtensionUiState`, and hand work to the agent with `api.submit(text, 'followUp')`,
   saying exactly what to do with which item.
6. **Write `README.md`**, opening with one sentence; the Info panel shows it.
7. **Look at it.** Switch to it, take a screenshot, and go through every state: loading, empty, error, setup, many
   items, a long title; then the light theme (⌘K, "Toggle light and dark theme"). Fix what looks off.
8. **Verify and commit**: `pnpm check` in the clone (it covers `.ultimate/extensions/`), then commit the folder with the
   project.

Keep in mind:

- Ids are global: surface ids, command ids, and dialog ids start with your extension name.
- Keep the agent on screen: a surface without a `Dock` holding `Conversation` makes the user switch away to talk.
- Reach your server only through actions: no `fetch` to your own endpoints, no secrets in the browser.
- One extension stays one folder. Prefer documents, commands, events, or the SDK to cross-extension imports; another
  extension's browser code comes only from its `ui.tsx` (see [Extension APIs](#the-browser-side-refsts-and-uitsx)).
  Lint enforces these declarations and forbids cycles.
- The Agent surface is an extension too: to change it for one project, copy `extensions/agent` to the project's
  `.ultimate/extensions/agent/`.

## SDK (`@/sdk`)

`@/sdk/*` deep imports are core internals, not extension API. Import only from `@/sdk`, `@/components/ui/*`, `@/components/ai/*`, `@/components/json-tree`, `react`, and `lucide-react`. Never call `fetch` or
open an `EventSource` yourself (`ultimate/no-raw-stream` fails lint on it in `extensions/**/*.tsx`): the SDK keeps one
live stream for the shown conversation plus one for each conversation whose documents are watched with `useDocOf`
(the shown one included), replays their changes, and your server code is reached through [actions](#actions). The surface primitives are in [Surfaces](#primitives).

| Hook                                                                      | Returns                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `useConversation(select?)`                                                | The shown conversation: `id`, `entries`, `agent` (`pi.agent`), `usage`, `live` (`pi.live`), `inbox`, `busy`, `loading`; with `select`, only that part, re-rendering when it changes (use it in tool and entry renderers) |
| `useSystem()`                                                             | Build identity, machine, process (pid, generation, url), persistence, code (branch, sha, dirty, coreStale), extensions, skills, context files                                                                            |
| `useConversations()`                                                      | Summaries of every conversation: id, parent, owner task, label (what its creator calls it, such as a subagent's definition), title, cwd, busy, latest user and assistant message times (`inputAt`, `answerAt`)           |
| `useTasks()`                                                              | The live task graph                                                                                                                                                                                                      |
| `useModels()`                                                             | `GET /api/models`: providers with auth status, models with context window, reasoning, cost; `refreshModels()` fetches it again after credentials change                                                                  |
| `useDoc(ref)`                                                             | The document a `docRef` in a `refs.ts` names, typed, on the shown conversation (`export const docs` in `server.ts`); `undefined` until the stream delivers it (subscribing creates it with its initial value)            |
| `useDocOf(conversation, ref)`                                             | `useDoc` of a given conversation, shown or not, such as the root (`1`) or a coordinator; `undefined` while `conversation` is undefined. Hooks on one conversation share one stream                                       |
| `useDocKind(kind)`                                                        | An untyped document by kind, only for views of every kind such as the Documents tab                                                                                                                                      |
| `useUiState(key, initial)`                                                | Durable UI state, stored with the main conversation: survives reloads and restarts, shared by every tab. `[value, set]`, JSON values only                                                                                |
| `useExtensionUiState(key, initial)`                                       | `useUiState` under `ext.<your extension>.<key>`; use it for your own UI state                                                                                                                                            |
| `useUltimate()`                                                           | `conversationId`, `surface`, actions (`switchConversation`, `showSurface`, `openPanel`, `closePanel`, `togglePanel`, `toggleSidebar`, `runCommand`, `open`/`close(dialog)`, `openPalette`, `focusComposer`, `setTheme`)  |
| `actionRef<Args, Result>(extension, name)`, `docRef<T>(kind)`             | Typed refs of a project extension's own actions and documents; built-ins keep theirs in `refs.ts`                                                                                                                        |
| `useAction(ref, args?, options?)`                                         | A server action's result, called on mount and when its args change: `{ data, error, loading, refetch }` (see [Actions](#actions))                                                                                        |
| `useDialog(id)`                                                           | `[open, setOpen]` for a dialog an `overlay` component renders; `useUltimate().open(id)` opens it anywhere                                                                                                                |
| `useConnection()`                                                         | Stream status: `connecting`, `open`, `reconnecting`                                                                                                                                                                      |
| `useRestart()`                                                            | `api.restart()` with its outcome: `run`, `busy`, `pending` generation, and `error` when a check or boot failed or an activation was rolled back                                                                          |
| `getConversation()`, `getState()`                                         | The same data now, outside React: in commands and callbacks. Components use the hooks.                                                                                                                                   |
| `useNotices()`, `useCommands()`, `useExtensions()`, `useNow(ms, active?)` | Server and client notices, all commands, installed web facets, a clock ticking every `ms` while `active`                                                                                                                 |
| `useDocumentRenderers()`                                                  | Registered document renderers by kind (see [Documents](#documents))                                                                                                                                                      |
| `useStore(select)`                                                        | Any slice of the client state (`State`), re-rendering when it changes                                                                                                                                                    |

`api` sends commands: `submit(text, whenBusy?)`, `abort()`, `configure({ model, thinkingLevel })`, `compact()`,
`createConversation()`, `restart()`, and `action(extension, name, args?)`. Conversation commands default to the shown
conversation.

`api.cancelSubmission(submissionId, conversationId?)` withdraws one queued input without stopping the run.

Helpers: `cn()` for class names, `formatTokens`, `formatBytes`, `formatDuration`, `formatTime`, `formatAgo(at, now)`
(`now`, `5m`, `3h`, `2d`, then a date; `{ ago: true }` reads `just now`, `5m ago`), `shortenPath(path, { cwd, home })`
(`home` is `useSystem().machine.home`), `elidePath`, `formatKeys`, and `errorMessage(error)` for a caught value. Types
for everything above are exported too (`EntryRecord`, `AssistantMessage`, `SystemInfo`, …).

Keep UI state that should survive a reload in `useExtensionUiState`; keep throwaway state (hover, an open menu) in
`useState`. The shell keeps its own layout there too (`shell.conversation`, `shell.surface`, `shell.shownSurface`,
`shell.panel`, `shell.panelOpen`, `shell.sidebarOpen`, `shell.dock.<surface>.<side>`).

## Styling

- Use the components first: `@/components/ui/*` (shadcn: button, checkbox, collapsible, command, dialog,
  dropdown-menu, kbd, popover, switch, tooltip) and `@/components/ai/*` (code block, conversation, message, reasoning,
  shimmer, tool, prompt input). Need another shadcn component? `pnpm dlx shadcn@latest add <component>` writes it to
  `web/src/components/ui`.
- Style with Tailwind utilities and the theme tokens: `bg-background`, `bg-card`, `bg-muted`, `bg-terminal`,
  `text-foreground`, `text-muted-foreground`, `border-border`, `text-brand` (the one accent), `text-success`,
  `text-warning`, `text-error`, `text-diff-add`, `text-diff-del`. Opacity modifiers work: `bg-error/10`. They follow
  the light and dark themes; never hard-code colours.
- No new CSS files, no inline style objects for colours.
- Dense and quiet: 12–14 px, monospace (`font-mono`) for meta such as paths, counts, ids, and durations; proportional
  for prose. Subtle borders (`border-border/70`), little motion.

## Conventions

- One feature per folder; the folder name is the extension name; a README is required. Keep it small.
- Prefer documents, commands, events, or the SDK. Another extension's runtime code is reached only through its
  `api.ts` on the server and its `ui.tsx` in the browser (see "Extension APIs"); type imports are free. Lint enforces
  both.
- Shared pure helpers live in the top-level `lib/`, not in another extension: `exec.ts` (run a program), `git.ts`
  (git and isolation checks), `json-file.ts` (read, atomic write, serialised update), `settings.ts`, `secrets.ts`
  (read-only), `cloud.ts` (the user's cloud settings),
  `project-identity.ts` (a project's GitHub key), `entries.ts` (`isInput`) and `agents.ts` (agent definitions and
  their discovery). Import them freely; they hot reload with the extensions that import them. `lib/` holds no state
  and imports no extension or `web/` code; only `agents.ts` reads the core project trust decision at runtime.
- Server facets: see `prompt/` for prompt sections and `coding-tools/server.ts` for tools; the root `AGENTS.md` explains
  reloads and durability. Server facets may `export const order = -100`: lower values come first, with the default 0
  keeping discovery order (built-in → user → project, then folder name); changing it reorders the server prompt and tools once.
- Prompt sections stay stable between turns: the same conversation renders the same text every time, so the prompt
  stays cached. Anything that changes while a conversation runs (a count, a list, a time) goes in a per-input note
  from a `beforeInput` hook instead. For example, `todos/server.ts` does not list open to-dos in a section; its
  `beforeInput` returns a note only when the list changed since the conversation last saw it.
