# React facets on a Solid core

Ultimate's UI is Solid. The shell, transcript, composer, sidebar and every built-in extension render with Solid 2 and
the UI kit in `web/src/components/ui/*.solid.tsx`. An extension's browser facet says its framework in its file name:

- `web.solid.tsx` is Solid. Its contributions are plain Solid components.
- `web.tsx` is React. It runs on a frozen compat layer (`web/src/compat/`), which loads React, react-dom, Radix and
  cmdk only when an enabled facet is a `web.tsx`. A page with none loads no React.

There is no deprecation date. A React facet keeps working as long as it uses what the compat layer still offers. When
part of it breaks, its error card says so and links here.

## What the compat layer keeps

- `@/sdk`: the React hooks (`useDoc`, `useDocOf`, `useAction`, `useUiState`, `useExtensionUiState`, `useConversation`,
  `useStore`, `useUltimate`, `useNow`, `useViewport`, …), `defineWebExtension`, `provide`, `definePoint`, `attention`,
  `renderEntry`, `island` and the formatters.
- The surface building blocks as React components: `Header`, `Sidebar`, `StatusLine`, `Conversation`, `Dock`, `Card`,
  `Fold`, `Slot`, `ExtensionBoundary`, `MessageActions`, `UserText`, `UserView`.
- The published kit and AI parts: `@/components/ui/{button,checkbox,collapsible,command,dialog,dropdown-menu,kbd,
  popover,skeleton,switch,tooltip}` and `@/components/ai/{tool,message}` (`MessageResponse` renders Markdown).
- The sidebar's points from `extensions/sidebar/ui.tsx`: `UnderUltimate`, `Unlisted`, `PreviewUp`.

## What changed

- **Points read by Solid hosts.** A React `provide(Point, useValue)` still works: the core runs the hook through the
  compat layer. UI-valued points now carry Solid elements, so a React provider returns a React element, which the core
  mounts for it. `ConversationPhase` lost its `label` (the sidebar draws the phase itself), and `ConversationTask` lost
  its `chip`. `<Provided>`, `<AllProvided>` and `<Rendered>` are no longer in `@/sdk`.
- **Markdown renderers** (`link`, `inlineCode`, `codeBlocks`) are Solid-only, as they have been since the Markdown step.
- **Internals.** Anything imported from Ultimate's internals by path (`@/../../extensions/<name>/…` other than the
  sidebar points above, `@/app/…`, `@/sdk/<file>`) is not part of the compat layer and may be gone. Other extensions'
  `ui.tsx` contracts are now `ui.solid.tsx`, and they are Solid.
- **`core`** passed to a React wrapper (an entry or tool renderer, a composer) is an opaque element: place it, don't
  inspect it.
- **The compat SDK is frozen.** New SDK features land in `@/sdk/solid` only.

## Move a facet to Solid

1. Rename `web.tsx` to `web.solid.tsx`, and every other `.tsx` in the folder to `.solid.tsx`. Start each with
   `/** @jsxImportSource @solidjs/web */`.
2. Import from `@/sdk/solid` instead of `@/sdk`, including surface parts. Use `@lucide/solid` instead of
   `lucide-react`, and `@/components/ui/<name>.solid.tsx` instead of `@/components/ui/<name>`.
3. Drop `island(…)`: contribute the component itself.
4. Rewrite the components in Solid 2: props are read, never destructured; `createEffect(compute, apply)`; readers
   return accessors (`doc()?.title`). Ultimate's `solid-ui` skill and
   `node_modules/solid-js/skills/solid-2.0/SKILL.md` have the rules.
5. A data provider becomes `provide(Point, (input) => createMemo(() => …))`: it gets the input as an accessor and
   returns one. A provider of UI is a component taking the input as props.

Asking your own Ultimate to do it ("move my-extension to Solid, following docs/extensions/react-compat.md") works well:
it can run `node scripts/check-extension.ts <folder>` from its Ultimate clone and look at the result in a preview.

## Keep it working with a local shim

If you would rather not move it yet, ask your Ultimate to add the missing piece next to your extension, not in
Ultimate's core:

- A deep import that is gone: copy the small part you used into your extension folder.
- A point's value that changed shape: adapt it in your own hook.
- A Solid component you need inside React: import it from its `*.solid.tsx` file and wrap it with `island(Component)`
  from `@/sdk`.

The error card names the facet and shows the error. That is usually enough for your Ultimate to find the cause.
