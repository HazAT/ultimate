# SDK (`@/sdk`)

Part of the [extension guide](../../extensions/README.md).

`@/sdk/*` deep imports are core internals, not extension API, except `@/sdk/solid`, the SDK for Solid files ([Solid facets](#solid-facets)). Import only from `@/sdk`, `@/components/ui/*`, `@/components/ai/*`, `@/components/json-tree`, `react`, and `lucide-react`. Never call `fetch` or
open an `EventSource` yourself (`ultimate/no-raw-stream` fails lint on it in `extensions/**/*.tsx`): the SDK keeps one
live stream per tab, carrying a subscription for the shown conversation plus one for each conversation whose documents
are watched with `useDocOf` (the shown one included), replays their changes, and your server code is reached through
[actions](actions.md). Browsers allow about six connections per host, so every further stream would hold back requests. The surface primitives are in [Surfaces](surfaces.md#primitives).

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
| `useAction(ref, args?, options?)`                                         | A server action's result, called on mount and when its args change: `{ data, error, loading, refetch }` (see [actions](actions.md))                                                                                      |
| `useDialog(id)`                                                           | `[open, setOpen]` for a dialog an `overlay` component renders; `useUltimate().open(id)` opens it anywhere                                                                                                                |
| `useConnection()`                                                         | Stream status: `connecting`, `open`, `reconnecting`                                                                                                                                                                      |
| `useRestart()`                                                            | `api.restart()` with its outcome: `run`, `busy`, `pending` generation, and `error` when a check or boot failed or an activation was rolled back                                                                          |
| `getConversation()`, `getState()`                                         | The same data now, outside React: in commands and callbacks. Components use the hooks.                                                                                                                                   |
| `useNotices()`, `useCommands()`, `useExtensions()`, `useNow(ms, active?)` | Server and client notices, all commands, installed web facets, a clock ticking every `ms` while `active`                                                                                                                 |
| `useDocumentRenderers()`                                                  | Registered document renderers by kind (see [documents](documents.md))                                                                                                                                                    |
| `useStore(select)`                                                        | Any slice of the client state (`State`), re-rendering when it changes                                                                                                                                                    |
| `useTranscriptScroll()`                                                   | In `transcript.*` slots: `{ scrollRef, contentRef, atBottom }`, the transcript's scroller, the element whose children are its rows (`data-entry-id`), and whether it follows its newest row                              |

`api` sends commands: `submit(text, whenBusy?)`, `abort()`, `configure({ model, thinkingLevel })`, `compact()`,
`createConversation()`, `restart()`, and `action(extension, name, args?)`. Conversation commands default to the shown
conversation.

`api.cancelSubmission(submissionId, conversationId?)` withdraws one queued input without stopping the run.

`uiAgent` is the page's one ui-sdk agent bridge: `bridge()` snapshots, queries, acts on and `subscribe`s to the
page's ui-sdk components.

Helpers: `cn()` for class names, `formatTokens`, `formatBytes`, `formatDuration`, `formatTime`, `formatAgo(at, now)`
(`now`, `5m`, `3h`, `2d`, then a date; `{ ago: true }` reads `just now`, `5m ago`), `shortenPath(path, { cwd, home })`
(`home` is `useSystem().machine.home`), `elidePath`, `formatKeys`, and `errorMessage(error)` for a caught value. Types
for everything above are exported too (`EntryRecord`, `AssistantMessage`, `SystemInfo`, …).

Keep UI state that should survive a reload in `useExtensionUiState`; keep throwaway state (hover, an open menu) in
`useState`. The shell keeps its own layout there too (`shell.conversation`, `shell.surface`, `shell.shownSurface`,
`shell.panel`, `shell.panelOpen`, `shell.sidebarOpen`, `shell.dock.<surface>.<side>`).

## Solid facets

A contribution can render with Solid 2 instead of React. Write the component in a `*.solid.tsx` file (read the
`solid-ui` skill first) and mount it from your `web.tsx` with `island`, the only place a React file may import it:

```tsx
import { defineWebExtension, island } from '@/sdk'
import { Status } from './status.solid.tsx'

export default defineWebExtension({ slots: { 'statusline.left': island(Status) } })
```

The island renders inside a `display: contents` element and remounts when its extension or conversation scope
changes. Solid code imports `@/sdk/solid`, never `@/sdk` (types excepted), and gets accessors:

| `@/sdk/solid`                                                                     | Returns                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `useDoc(ref)`, `useDocOf(() => conversation, ref)`                                | An accessor of the document; a memo or JSX reading `doc()?.columns[0].title` reruns only when that path changes. `useDoc` follows the scope                                                                 |
| `useUiState(key, initial)`, `useExtensionUiState(…)`                              | `[value, set]`: `value` is an accessor, `set` takes a value or an updater, as in React                                                                                                                      |
| `useConnection()`, `useSystem()`, `useConversations()`                            | Accessors of the same client state the React hooks read                                                                                                                                                     |
| `useAction(ref, args?, options?)`                                                 | `{ data, error, loading, refetch }`, the first three accessors, sharing React's call and result; `on` takes an accessor, such as a document's; `conversation: ROOT` calls it on the root, not the shown one |
| `useNow(ms, () => active)`                                                        | An accessor of the current time, ticking every `ms` while `active`                                                                                                                                          |
| `useEvents(options?)`, `useCommands()`                                            | Accessors of the durable event feed and the command list, as the React hooks read them                                                                                                                      |
| `useEvent(channel, handler)`, `events`                                            | The page's event bus: subscribe for the component's life, or `events.emit`                                                                                                                                  |
| `useRestart()`, `useCopy()`                                                       | As in React, with accessors: `busy()`, `pending()`, `error()`; `copied()`                                                                                                                                   |
| `switchConversation`, `showSurface`, `runCommand`, `notify`                       | Shell navigation, a command by id, a notice                                                                                                                                                                 |
| `bundle`, `switched`                                                              | The web bundle this page runs, and whether this load switched to it                                                                                                                                         |
| `ExtensionName`, `ConversationScope`                                              | The contexts `island` provides                                                                                                                                                                              |
| `api`, `ROOT`, `docRef`, `actionRef`, `cn`, `format*`, `errorMessage`, `keepLast` | The same helpers `@/sdk` exports                                                                                                                                                                            |

## Rendering another conversation

Wrap `<Conversation/>` in `<ConversationScope id={id}>` (both from `@/sdk`) to render another live conversation without
switching the shell. `useConversation(select?)`, `useTranscript`, `useDoc`/`useDocKind`, `useUltimate().conversationId`,
`useCompact`/`useCompactThread`, and `useAction` follow the nearest scope, as do transcript/composer
contributions. Scopes of the same id share a stream; the last unmount releases it. Outside a scope these hooks keep
their existing behaviour. A shortcut pressed inside a scope runs its command with the scope's id as
`context.conversationId` (Escape stops the scoped run). Explicit `useDocOf` ids, root UI state, shell navigation, the
palette, `getConversation()` without an id and the imperative `api` stay global: callbacks using `api` must pass the
scoped id explicitly when acting on it, as toolbar contributions do with `useConversation().id`.
