# Contracts: `api.ts`, `refs.ts`, `ui.tsx` and points

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
- `api-only-imports`: a server-side `.ts` file imports another extension's runtime code only from its `api.ts`, a
  browser `.tsx` file only from its `ui.tsx`, and its `api.ts` or `refs.ts` only as types; types come with
  `import type`, pure helpers from `lib/`.

## The browser side: `refs.ts` and `ui.tsx`

`api.ts` describes server code and may reach it through type imports, so the browser never imports it. An extension
whose documents or actions the browser uses describes them in `refs.ts`: `docRef<T>(kind)` for each document and
`actionRef<Args, Result>(extension, name)` for each action the browser reads or calls, from
`shared/extension-api.ts`, and the extension's event tokens (`defineEvent`). `api-file-shape` holds it to the same
documentation as `api.ts`: every action ref names its arguments and result, since agents read it before
`ultimate.action`. It stays browser-safe: runtime imports of `shared/` only, types only from packages, `shared/` and
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

The web reads and calls through the refs, typed: `useDoc(LogDoc)`, `useDocOf(1, LogDoc)`, `useAction(EchoAction,
args)`, `api.action(EchoAction, args)`; `useDocKind(kind)` is the untyped escape for views of every kind (the
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

What other extensions' browser code uses (shared components, hooks and the refs they need) is exported from the
owner's `ui.tsx`, which starts with a doc comment on what it offers.

## Web points

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
order, a throwing one left out behind its inline error card.

A piece of UI other extensions may redraw (a line, a header, a row) renders through `<Rendered point input>` with its
own rendering as children. Its point's input carries `core`, the rendering so far, and each provider in discovery order
returns it, wraps it or replaces it, as entry renderers do; one that throws falls back to the rendering it got:

```tsx
// context/ui.tsx
export const CacheRebuiltLine = definePoint<
  { entry: EntryRecord; bust: CacheBust; core: ReactNode },
  ReactNode
>('context.cache-rebuilt')
// context/web.tsx: <Rendered point={CacheRebuiltLine} input={{ entry, bust }}>{line}</Rendered>
// my-extension/web.tsx: provide(CacheRebuiltLine, ({ bust, core }) => (bust.written > 100_000 ? <MyLine bust={bust} /> : core))
```

The web core declares its own points in the SDK: `ParkedRuns`
(pause), `RunStart` (tasks), `ConversationKind` (the title bar's kind before a title; messages names coordinator
branches `branch · coordinator`), `ComposerPlaceholder` (what an empty composer says, the last provider that answers
winning; conversations addresses a standing agent by its definition's `title`) and `MessageReference` (the copyable
reference to a stored message; codemode). The server's counterpart is the extension point above.
