## Extension mechanics

Each extension is a folder `extensions/<name>/`: `server.ts` exports a Durable extension with that name
(or a factory receiving `ExtensionHost`, which provides `ultimateRoot` (the clone), `projectRoot` (your work), state/home paths, models/settings, build and system inspection, conversation summaries, harness access, shared resources, and lifecycle hooks), `web.tsx` is its optional browser facet
(`defineWebExtension` from `@/sdk`), and `README.md` describes it. The server facet may export `docs`, an array of conversation document tokens;
read their `doc` snapshots and `docOps` batches from `/api/events`. A browser tab keeps one such stream; its first
event, `stream`, carries the id with which `POST /api/events/<stream>/<sub>` (`{ conversation?, docs?, view? }`)
subscribes to a conversation and `DELETE` ends that (`ServerEvents` in `shared/protocol.ts`). A subscription's
`view`, `ops`, `doc` and `docOps` events carry its id on their first data line, so their `data` reads `<sub>\n{…}`:
parse what follows the first newline.
The Documents tab shows each exported kind through the renderer a web facet registers (`documents: [{ kind, title, component }]`), or as JSON.
Local imported modules reload with the facet. Failed loads leave the previous version installed.

Server extensions coordinate through typed contracts in each provider's `api.ts`: services, extension points,
documents and durable events (below). The
browser has its own ephemeral `events`/`useEvent` bus from `@/sdk`. Use `<extension>:<event>` channels there, reserve
`ultimate:*` for core, and keep durable state in documents. `useReady()` becomes true once the initial facets settle and a system snapshot
arrives, stays true across hot reloads, and exposes failed facet names. Overlays render as facets install, even while
others load; see [Events](../extensions/README.md#events).

## Durable events

For "this happened" that other extensions act on or people read later, use a durable event. Define its token once
with `defineEvent<Data>('<extension>.<event>', { version? })` from `shared/events.ts` in the emitter's `refs.ts`, so
the browser can use it too, and re-export it from `api.ts` (for server code) and `ui.tsx` (for other extensions'
browser code). Then:

- `host.emit(tx, Event, data)` appends it inside your commit, so it exists exactly when your state change does.
- `host.react(name, [Event, …], (tx, event) => …)` runs the handler once per event, oldest first: those emitted before
  it started, then each new one, serially per name (`<extension>/<name>`). The cursor advances in the handler's
  transaction, so writes through `tx` happen exactly once across crashes, reloads and failures; side effects outside
  `tx` (files, processes, network) are at least once. A throw rolls back the handler and the cursor, records the
  failure, and retries the event on the next matching commit or harness open. Reactors run while the harness is open
  and stop with their facet; a reloaded facet registering the same name continues from the cursor. Pass
  `{ from: 'now' }` as a fourth argument when past events must not be handled: a reactor without a cursor then starts
  after the newest event instead of replaying the log.
- `host.eventLog.recent({ events?, since?, before?, order?, limit })` reads the newest first (oldest first with
  `order: 'ascending'`) as plain copies, `since` and `before` exclusive event ids; `host.eventLog.reactors()`
  shows each reactor's cursor, lag and last failure. In the browser, `useEvents({ events?, limit })` from `@/sdk` streams
  the root's feed of the latest 100 events.

Each distinct `host.notice` message of a facet is also recorded as an `ultimate.notice` event while storage is open.
Keep events few and small: they are history.

The events today: `lineage.branched` and `lineage.rooted` (lineage has conversations mark the intent title as
generated), `workspaces.landed` (lineage notes the submitter's tree root) and `models.login-changed` (health resets
the provider's record). Recorded for the history and
the system stream: `ultimate.started` (storage opened: generation, build), `subagents.started` (a subagent,
automation run, new standing agent or branch configured: agent, model, thinking, parent), `board.sent` (a message
posted: ids, `reply`, `steer`, never the text), `workspaces.check` (each lander check run: command, result, ms),
`conversations.compacted`, `health.changed` (a provider's state flipped), `cloud.backup` (started, done or failed),
`coding-tools.committed` (a commit made through bash: full sha, repo, worktree, branch). The last four follow state
outside the caller's commit (Pi's compaction, the machine's health file, an upload, a git repository), so each commits on
its own right after it. For debugging what the user did: `user.input` (a typed prompt, steer or follow-up, an
answer or dismissal, a review: its conversation, entry or message and length, never the text) and
`ui.navigated` (the surface or Agent's conversation changed, reported by the browser after a second and deduped),
each with the browser's `device` label and, through Tailscale Serve, the `login` and the client's tailnet `address`
(`100.64.0.0/10` or `fd7a:115c:a1e0::/48`, for example `100.64.0.2`; any other forwarded address is dropped). UI
action calls get the same `Device` as `ctx.device`. A `beforeInput` hook gets no device: it sees only the input entry
and runs for queued inputs too, so record the device from a UI action instead. A typed input and a review commit
right after Pi admits them, which has no hook for queued inputs; answers commit with their reply. Something the user must see
exactly once and that feeds the result the owner reports, like the lander waking a landed branch's starter, stays a
call, idempotent by request id; when it calls up the layering, it goes through an extension point (below).
`onCommit(host.harness(), …)` (`lib/commits.ts`, over Pi Durable's `Session.observeCommits`) remains for watching Pi's
own records (entries, tasks, submissions, conversation records, usage and live documents), which are no domain events;
each such watcher says so in a comment above it. Do not invent an event only to replace one.

## Core tier

The core tier is the fixed heart of Ultimate that every other extension may rely on. An extension joins it with one
line in its `api.ts`, `export const tier = 'core'` (`coreTier` in `shared/extension-api.ts`); nothing in `server/`
names them. Discovery reads the line: a core-tier extension stays enabled whatever `extensions.disable` says (the
ignored entry becomes an extension diagnostic), and `ExtensionInfo.core` marks it, so the first-run choices and the
Extensions panel show it as `core` with a locked switch. Being always on, a core-tier service is there for every
extension: consumers `need` it. `want` is for optional extensions' services and for extension points, which another
extension fills. `test/e2e/disable-each.test.ts` boots with each optional extension disabled in turn and expects a
clean catalogue.

Today's core tier: agent, prompt, coding-tools, conversations, models, documents, notices, secrets, theme,
workspaces, subagents, lineage, messages, onboarding (the first run and @ultimate's setup cards need it) and sidebar.

Dependencies point one way. A core-tier extension imports (runtime or type), needs and wants only core-tier
extensions; lint's `core-tier-deps` enforces the imports, and the catalogue has no cycles. `pnpm deps`
(`scripts/deps.ts`, part of `pnpm check`) prints the graph between built-in extensions, from every import (runtime,
type, re-export, dynamic) and every `need`/`want` of another extension's token, and fails on a cycle or a core-tier
extension depending on an optional one. The core layers, lowest first, each depending only on layers below it:

1. prompt, coding-tools, documents, notices, secrets, theme: stand alone.
2. models.
3. conversations: titles, summaries, overview, concluding; `ConversationRef`, `FeatureTag`, `AgentMark`.
4. workspaces: worktrees and the lander.
5. subagents: child conversations and standing agents.
6. lineage: roots, branches, tallies, notes.
7. messages: delivery and the `branch` tool.
8. onboarding and agent.
9. sidebar: the sidebar and the @ultimate button, the UI that brings the core together.

Where a lower extension needs something a higher one knows, it declares the contract and the higher one fills it:
server extension points (`conversations.trees` and `conversations.release` from conversations, `workspaces.branches`
from workspaces), web points (`conversations.phase`, `conversations.task`, `conversations.unsummarized`,
`messages.answers`, `lineage.memory-header`, `workspaces.review`), or durable events (`workspaces.landed`,
`models.login-changed`). Optional extensions plug into the core the same way: phase, plan and questions provide
points and react to events; the core never imports them. A web point is `definePoint` in the owner's `ui.tsx`,
rendered with `<Provided>` and filled by `provides` in another facet (see
[Talking to other extensions](../extensions/README.md#the-browser-side-refsts-and-uitsx)).

## Extension APIs

A service one extension offers another is a typed token, `defineApi<Service>()('name')` from
`shared/extension-api.ts`, kept in the provider's `api.ts`. The provider
calls `host.implement(Token, value)`; consumers call `host.need(Token)` for a hard dependency or `host.want(Token)` for
an optional one. Both return a handle that resolves the current provider on every member access, so a handle taken at
setup survives provider reloads. Every method call goes through one internal `call`, which traces it (below).
`need` throws `<ext> needs <api>, which no enabled extension provides` while nothing provides it (at setup it records
the dependency instead, since the provider may load later, and the missing provider becomes an extension diagnostic);
`want` returns undefined. `host.catalogue()` and codemode's `ultimate.catalogue()` list each API's provider, needs
and wants, the missing providers and the dependency cycles (each a sorted group of extensions that depend on each
other in a cycle).

An **extension point** is how a lower extension calls up without depending on a higher one: it declares the contract
in its own `api.ts` as `defineApi<Service>()('<folder>.<point>')` (for example `conversations.trees`) and `want`s it;
the higher extension imports that token and `implement`s it. The catalogue counts every edge toward the contract's
owner, the extension its name starts with: consumers depend on it, and so does a point's provider. A point's row
carries `owner` and lists its provider; the owner wanting its own point depends on nothing, so the dependency keeps
pointing down.

An extension's `api.ts` is its whole server-side surface for others, and agents discover APIs by reading these files,
so lint (`lint/ultimate.ts`) keeps them small and documented:

- `api-file-shape`: the file starts with a doc comment on what it offers, its first sentence the one-line summary.
  It holds only imports (runtime ones of `shared/`, packages, its own `refs.ts` and other extensions' `api.ts`;
  anything else with `import type`; no `node:*`), types, `export const X = defineApi/defineDoc/defineEntry(...)`,
  re-exports of its own `refs.ts` (where event tokens live) and `export const tier = 'core'`. Every exported token
  and every member of a service type passed to `defineApi` has a doc comment saying what it does and when to use it.
- `api-naming`: `defineApi<…>()('<folder>')` or an extension point `('<folder>.<point>')`,
  `defineEvent('<folder>.<event>')` and `actionRef('<folder>', name)`.
- `api-only-imports`: a server-side `.ts` file imports another extension's runtime code only from its `api.ts`, a
  browser `.tsx` file only from its `ui.tsx`; types come with `import type`, pure helpers from `lib/`.

`api.ts` type-imports server code, so the browser never imports it. The browser's contract is two more files:

- `refs.ts`: `docRef<T>(kind)` for each document and `actionRef<Args, Result>(extension, name)` for each action the
  browser reads or calls, from `shared/extension-api.ts`, and the extension's event tokens (`defineEvent`). The SDK
  takes them typed: `useDoc(ref)`, `useDocOf(conversation, ref)`, `useAction(ref, args)`, `api.action(ref, args)`; `useDocKind(kind)` is the untyped
  escape for views of every kind (the Documents tab). `api-file-shape` holds it to the same documentation as `api.ts`
  (an action ref documents its arguments and result, which agents read before `ultimate.action`) and keeps it
  browser-safe: runtime imports of `shared/` only, types from packages, `shared/` and extensions' `refs.ts` or
  `types.ts`, and `tsconfig.web.json` type-checks it with the web. The server is tied to the same refs: its
  `defineDoc` uses `kind: Ref.kind`, and each action handler is `implementAction(Ref, handler)` (`lib/actions.ts`),
  whose types fail when the handler returns something other than the ref's result or reads an argument name the
  ref does not declare (`ActionInput`). `test/refs.test.ts` fails when an action ref has no `implementAction` of that
  ref in its extension's `actions`, or a doc ref names a kind no server facet's `docs` exports.
- `ui.tsx`: what other extensions' browser code imports, components, hooks and the refs they need, opening with a doc
  comment on what it offers.

Pick the channel by what crosses it: services for calls between extensions, documents for durable state, durable
events (above) for "this happened", actions for the UI and user boundary.

## Tracing

`server/trace.ts` records every service call (`<caller extension>` → `<api>.<method>`), extension action
(`ui` or `agent` → `<extension>/<action>`), reactor run (event name → `<extension>/<reactor>`) and tool execution
(`agent`, or the calling tool's extension for a tool another running tool calls, as a Pi nested call or directly
like codemode's `tools.*` → tool name) with its duration, `ok` and error message.
Each runs in a trace context (AsyncLocalStorage, which survives Pi Durable commits and its task runner) of
`{ traceId, conversationId?, taskId?, entryId?, parentCall? }`: a call is the parent of the calls it makes, a tool
call carries its conversation, task and the assistant entry holding the call, and `host.emit` stamps the context on
the event so its reactors continue the emitter's trace. Nothing to do in an extension: `implement`, actions,
`react` and tools are traced for you.

Every model stream is a `model` row too (`agent` for Pi's generations and compactions, `extension` for an
extension's own call → `<provider>/<model>`): its duration, input, output and cache tokens and stop reason, never the
prompt or the response; an error or aborted stop is a failed row whose error is only a classification (stop reason,
HTTP status and allowlisted error codes), since a provider message can echo the request. `completeSimple` (health's
pings) goes through the same wrapper, as does the `modelRuntime` extensions call directly. Pi runs requests outside any traced call but sends
the conversation's provider session id, so a `beforeRequest` hook (`model-trace`, `server/tool-arguments.ts`) maps
session ids to conversations; a request before its conversation's first generation in this process (a compaction just
after a restart) stays unlinked, and an extension's call belongs to the call it runs in.

UI polls would otherwise fill the trace: a successful action or service call that starts its trace and repeats one
written within the last minute (same name, same argument summary), or an action an extension lists in `pollActions`,
is not written, nor the plain action and service calls it makes; it is counted instead, and `host.trace.polls()`
lists the counts since the trace opened (`{ name, count, since }`, most first). Failures, model, tool and sealed calls
are always written, and one written under a poll writes the chain above it too, so its tree stays whole. A poll that
emits a durable event is written as well (`emit` calls the trace's `keep`): its reactors run later under the event's
copy of its context and need it as their parent. Marks are kept by call id, so such copies match. On this host
it cuts writes by ~89 %.

Arguments and results are stored as JSON summaries of about 300 characters with values under keys matching
`/secret|token|password|key|auth/i` replaced by `[redacted]`; tool calls keep none (the transcript has them). Calls
into the extensions that handle credentials, `secrets` (secret values) and `models` (API keys and OAuth codes
answering a login), keep neither, nor an error message, only the error's class. A new extension whose actions or
services take or return credentials joins `SEALED` in `server/trace.ts`. Rows go to `<home>/trace.sqlite` in batches outside Pi commits, while
the harness is open only; retention keeps 7 days and at most 200,000 rows. A trace failure is logged once and never
fails the call. Read with `host.trace.query({ trace?, conversation?, since?, limit })` (the newest `limit`, oldest
first), `host.trace.page({ before?, after?, since?, until?, kinds?, conversation?, errors?, text?, limit })` (calls by write
position `seq`, which is finish order, for paging; the `system` extension's stream uses it),
`host.trace.tree(traceId)` (calls nested under `children`) and `host.trace.polls()`, or codemode's
`ultimate.trace(...)` and `ultimate.traceTree(traceId)`. The `system` extension merges the trace and the event log
into one paged stream (`extensions/system/README.md`).

## Inspecting yourself

Use `codemode` to compose dependent or parallel `tools.*` calls and filter results before they enter your context. Its `ultimate.*` API is the way to inspect yourself: system/build, extension facets and load errors, conversations, stored entries and search (including before compactions/resets), the extension API catalogue, the extension contracts (`ultimate.apis()` lists them, `ultimate.api(name)` returns an extension's `api.ts` and `refs.ts`), the call trace, task graph, models, and exported documents. @ultimate has the same reads as its `debug` tool (`extensions/debug/README.md`). `ultimate.action(extension, action, args?)` is its one write: call an extension action on behalf of this conversation. Use ordinary tools for other writes and single simple calls. `store`/`load` persist conversation-scoped values; see `extensions/codemode/README.md` for interruption semantics.
