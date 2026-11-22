# Contracts: `api.ts`, `refs.ts`, `ui.solid.tsx` and points

Part of the [extension guide](../../extensions/README.md). An extension reaches another only through these files;
lint enforces it. Pick the channel by what crosses it: services for calls between extensions, documents for durable
state, [durable events](events.md) for "this happened", [actions](actions.md) for the UI and user boundary.

## Services in `api.ts`

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

A service is a typed token, `defineApi<Service>()('name')` from `shared/extension-api.ts`. The provider calls
`host.implement(Echo, { echo: (text) => text })` in its factory; it is staged, replaced and removed with its facet.
Consumers call `host.need(Token)` for a hard dependency or `host.want(Token)` for an optional one (the
[core tier](core-tier.md) is always on, so its services are always `need`ed). Both return a handle that resolves the
current provider on every member access, so a handle taken at setup survives provider reloads. Every method call goes
through one internal `call`, which [traces](introspection.md#tracing) it. `need` throws
`<ext> needs <api>, which no enabled extension provides` while nothing provides it (at setup it records the dependency
instead, since the provider may load later, and the missing provider becomes an extension diagnostic); `want` returns
undefined. `host.catalogue()` and codemode's `ultimate.catalogue()` list each API's provider, needs and wants, the
missing providers and the dependency cycles (each a sorted group of extensions that depend on each other in a cycle).

An **extension point** is how a lower extension calls up without depending on a higher one: it declares the contract
in its own `api.ts` as `defineApi<Service>()('<folder>.<point>')` (for example `conversations.trees`) and `want`s it;
the higher extension imports that token and `implement`s it. The catalogue counts every edge toward the contract's
owner, the extension its name starts with: consumers depend on it, and so does a point's provider. A point's row
carries `owner` and lists its provider; the owner wanting its own point depends on nothing, so the dependency keeps
pointing down.

## Lint rules

An extension's `api.ts` is its whole server-side surface for others, so lint (`lint/ultimate.ts`, rules prefixed
`ultimate/`) holds every `extensions/*/api.ts` to the shape above, small and documented:

- `api-file-shape`: the file starts with a doc comment on what it offers, its first sentence the one-line summary.
  It holds only imports (runtime ones of `shared/`, packages, its own `refs.ts` and other extensions' `api.ts`;
  anything else with `import type`; no `node:*`), types, `export const X = defineApi/defineDoc/defineEntry(...)`,
  re-exports of its own `refs.ts` (where event tokens live) and `export const tier = 'core'`. Every exported token
  and every member of a service type passed to `defineApi` has a doc comment saying what it does and when to use it.
- `api-naming`: `defineApi<…>()('<folder>')` or an extension point `('<folder>.<point>')`,
  `defineEvent('<folder>.<event>')` and `actionRef('<folder>', name)`.
- `api-only-imports`: another extension's runtime code comes only from its `api.ts` in server code, or its `refs.ts`
  or `ui.solid.tsx` in Solid code. Import types with `import type`; shared pure helpers live in `lib/`.

## The browser side: `refs.ts` and `ui.solid.tsx`

`api.ts` describes server code and may reach it through type imports, so the browser never imports it. An extension
whose documents or actions the browser uses describes them in `refs.ts`: `docRef<T>(kind)` for each document and
`actionRef<Args, Result>(extension, name)` for each action the browser reads or calls, from
`shared/extension-api.ts`, the extension's event tokens (`defineEvent`), and the entry kinds other extensions read
(`defineEntry<D>(kind)` from Pi Durable, so a renderer narrows with `Token.is(entry)` instead of casting `entry.data`).
`api-file-shape` holds it to the same documentation as `api.ts`: every action ref names its arguments and result,
since agents read it before `ultimate.action`. It stays browser-safe: runtime imports of `shared/` and Pi Durable's
`defineEntry` only, types only from packages, `shared/` and
extensions' `refs.ts` or `types.ts`, and `tsconfig.web.json` type-checks it with the web.

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

The web reads and calls through the refs, typed: `useDoc(LogDoc)`, `useDocOf(() => ROOT, LogDoc)`, `useAction(EchoAction,
args)`, `api.action(EchoAction, args)`; `useDocKind(() => kind)` is the untyped escape for views of every kind (the
Documents tab). The server ties itself to the same refs: its `defineDoc` uses `kind: LogDoc.kind`, and each handler
is `implementAction(Ref, handler)` from `lib/actions.ts`, which fails the type check when the handler's result is not
the ref's or it reads an argument the ref does not name (`ActionInput`):

```ts
export const actions = {
  echo: implementAction(EchoAction, async (args, ctx) => {
    const text = args && typeof args === 'object' && !Array.isArray(args) ? args.text : undefined
    if (typeof text !== 'string') throw new Error('Expected { text }')
    return { at: await log(ctx.host, text) }
  }),
}
```

`test/refs.test.ts` fails when an action ref has no `implementAction` of that ref in its extension's `actions`, or a
doc ref names a kind no server facet's `docs` exports.

Components, readers and points other extensions' Solid code uses are exported from the owner's `ui.solid.tsx`.
It opens with a doc comment on what it offers (`extensions/conversations/ui.solid.tsx`).

## Web points

A lower extension can ask for something a higher one knows without importing it. It declares a **point** with
`definePoint<Input, Value>('<owner>.<point>')` and exports it from `ui.solid.tsx`. The higher extension imports the
point and lists `provide(Point, value)` under `provides` in `web.solid.tsx`. Both helpers come from `@/sdk/solid`.

- **Data:** `value` is `(input: Accessor<Input>) => Accessor<Value>`, called once per reader. For example, `instance`
  fills the sidebar's `PreviewUp` point with `provide(PreviewUp, previewUp)`, where `previewUp` receives an id
  accessor and returns an accessor of whether that conversation has a running preview. `useProvided(PreviewUp, id)`
  returns an accessor of the last value in discovery order, or `undefined` without a provider. Use `useAllProvided`
  for every value in order, with throwing providers left out.
- **UI:** `value` is a Solid component taking the point's input object as props. The Inbox fills the sidebar's
  `UnderUltimate` point with `provide(UnderUltimate, InboxSidebar)`. The sidebar renders
  `<Provided point={UnderUltimate} input={{ conversation: data.ultimateId() }} />` to show every provider in order
  (`last` keeps only the last). A throwing provider shows an inline error card without hiding the others.

`useProvided`, `useAllProvided` and `Provided` come from `@/sdk/solid`.

The web core declares its own points in the SDK: `ParkedRuns`
(pause), `RunStart` (tasks), `ConversationKind` (the title bar's kind before a title; messages names coordinator
branches `branch · coordinator`), `ComposerPlaceholder` (what an empty composer says, the last provider that answers
winning; conversations addresses a standing agent by its definition's `title`), `EmptyTranscript` (what a transcript
shows before its first message; each provider receives `core`, the rendering so far, to keep, wrap or replace;
conversations shows a standing agent's mark and title) and
`MessageReference` (the copyable reference to a stored message; codemode). The server's counterpart is the extension point above.
