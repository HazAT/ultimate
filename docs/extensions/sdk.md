# Solid SDK (`@/sdk/solid`)

Part of the [extension guide](../../extensions/README.md).

## Solid facets

An extension's `web.solid.tsx` contributes plain Solid components. Import SDK features from `@/sdk/solid`, including
`defineWebExtension`, readers, point providers, and surface and transcript parts such as `Header`, `Conversation`,
`Card` and `Fold`. See [Surfaces](surfaces.md#primitives) for layout and [Contracts](contracts.md#web-points) for points.

```tsx
import { defineWebExtension } from '@/sdk/solid'
import { Status } from './status.solid.tsx'

export default defineWebExtension({ slots: { 'statusline.left': Status } })
```

Use `@/components/ui/<name>.solid.tsx` for controls, `@/components/markdown/markdown.solid.tsx` for Markdown,
`@/components/json-tree.solid.tsx` for JSON and `@lucide/solid` for icons. Other SDK paths are internal.

Never call `fetch` or open an `EventSource` to reach Ultimate (`ultimate/no-raw-stream`). The SDK keeps one live stream
per tab, carrying subscriptions for the shown conversation and any others watched with `useDocOf`. Call server code
through [actions](actions.md).

## Reading and acting

Readers return accessors. Call them where you use them, in JSX or a memo, not once at the top of the component. For
example, `const doc = useDoc(MyDoc)` and `<span>{doc()?.title}</span>` update that span when the title changes.

| `@/sdk/solid`                                                                                           | Returns                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `useConversation()`, `useConversationId()`                                                              | The scoped or shown conversation (`id`, `loading`, `entries`, `agent`, `usage`, `live`, `inbox`, `busy`) or just its id.                                                                      |
| `useAgent()`, `useConversationSummary(id)`                                                              | The scoped or shown conversation's `pi.agent`, or the summary for the id accessor (title, label, busy, parent).                                                                               |
| `useDoc(ref)`, `useDocOf(() => id, ref)`                                                                | A typed document. `useDoc` follows the scope; `useDocOf` follows the given id accessor. `undefined` until the stream delivers it, `null` until the document is created.                       |
| `useDocKind(() => kind)`                                                                                | The untyped document by kind, for views such as the Documents tab.                                                                                                                            |
| `useUiState(key, initial)`, `useExtensionUiState(key, initial)`                                         | `[value, set]`: `value` is an accessor and `set` takes a JSON value or updater. `useExtensionUiState` uses `ext.<extension>.<key>`. Both survive reloads and restarts and are shared by tabs. |
| `useAction(ref, args?, options?)`                                                                       | `{ data, error, loading, refetch }`: the first three are accessors. `on` takes an accessor to refetch on; `conversation: ROOT` reads on the root. See [actions](actions.md).                  |
| `useConnection()`, `useSystem()`, `useConversations()`, `useTasks()`, `useModels()`                     | Stream status, system info, conversation summaries, the live task graph and the model list. `refreshModels()` asks for the list again.                                                        |
| `useStore(select)`, `getState()`, `getConversation(id?)`                                                | A reactive slice of the client state, or current data for commands and callbacks.                                                                                                             |
| `useTranscript()`, `useTranscriptElements()`                                                            | The loaded entries, oldest first; `{ scroll, content }` accessors for the scroller and the container whose children are rows.                                                                 |
| `useNotices()`, `useCommands()`, `useExtensions()`, `useViewport()`                                     | Notices, command list, installed web facets and viewport.                                                                                                                                     |
| `useEvents(options?)`, `useEvent(channel, handler)`, `events`                                           | The durable event feed and the page event bus. `useEvent` subscribes for the component's life; `events.emit` sends on the bus.                                                                |
| `useNow(ms, () => active)`                                                                              | The current time, ticking every `ms` while active.                                                                                                                                            |
| `useDialog(id)`                                                                                         | `[open, setOpen]` for a dialog an `overlay` component renders; `open` is an accessor.                                                                                                         |
| `useRestart()`, `useCopy()`                                                                             | Restart or copy helpers with state accessors (`busy()`, `pending()`, `error()`; `copied()`).                                                                                                  |
| `switchConversation`, `showSurface`, `runCommand`, `openPanel`, `closePanel`, `focusComposer`, `notify` | Shell navigation, commands and notices.                                                                                                                                                       |
| `fillComposer`, `insertIntoComposer`, `composerDraft`                                                   | Replace or insert into a conversation's composer draft; read (and clear once sent) the text and images in it.                                                                                 |
| `bundle`, `switched`                                                                                    | The web bundle this page runs and whether this load switched to it.                                                                                                                           |
| `holdReload()`                                                                                          | Holds the switch to a new bundle until the returned release runs (`screen-recorder` holds it while recording).                                                                                |

`api` sends commands: `submit(text, whenBusy?)`, `abort()`, `configure({ model, thinkingLevel })`, `compact()`,
`createConversation()`, `restart()`, and `action(ref, args?)`. Conversation commands default to the shown conversation.
`api.cancelSubmission(submissionId, conversationId?)` withdraws one queued input without stopping the run.

Use `docRef<T>(kind)` and `actionRef<Args, Result>(extension, name)` for typed refs (built-ins keep theirs in `refs.ts`).
Helpers include `cn()`, `formatTokens`, `formatBytes`, `formatDuration`, `formatTime`, `formatAgo(at, now)`,
`shortenPath(path, { cwd, home })` (`system()?.machine.home` where `system = useSystem()`), `elidePath`, `formatKeys`, `prettyName`,
`errorMessage` and `keepLast`.

Keep UI state that should survive a reload in `useExtensionUiState`; use a local signal for throwaway state.

## Rendering another conversation

Wrap `<Conversation />` in `<ScopedConversation id={id}>` (both from `@/sdk/solid`) to render another live
conversation without switching the shell. Conversation and transcript readers, `useDoc`/`useDocKind`, `useCompact`,
`useAction` and shortcuts pressed inside the scope follow its id (Escape stops the scoped run). Scopes of the same id
share a stream; the last unmount releases it. Explicit `useDocOf` ids, UI state, shell navigation, the palette,
`getConversation()` without an id and imperative `api` commands stay global. Pass the scoped id explicitly when a callback
uses `api` to act on it, as toolbar contributions do with `useConversationId()`.
