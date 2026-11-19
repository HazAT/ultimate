---
name: solid-ui
description: Write or review Solid 2.0 UI in Ultimate (a `*.solid.tsx` file, a UI kit component, a Solid extension facet) with ui-sdk components and behaviors. Use before writing or changing any `.solid.tsx` file or anything under web/src/components/ui, and when moving a React component to Solid.
---

# Solid UI in Ultimate

Ultimate's UI is moving from React to Solid 2.0, with Vercel UI SDK (`@ui-sdk/*`) underneath its components. Both are
newer than most models' training data, and Solid 2.0 is not Solid 1.x, so habits from either one are the main source of
bugs. The skills that the libraries ship match the exact pinned versions: read them, not your memory.

## Read first, from the installed packages (in the Ultimate clone)

1. `node_modules/solid-js/skills/solid-2.0/SKILL.md`: the three rules and the table of Solid 1.x names that no longer
   exist. Read it every time before you write Solid.
2. `node_modules/@ui-sdk/core/skills/ui-sdk/SKILL.md`: how to compose ui-sdk, make it agent-ready and test it. Our
   framework is `solid`, so its docs index is `node_modules/@ui-sdk/solid/docs/llms.txt`; open only the component pages
   you use.
3. When an unfamiliar name comes up: `node_modules/solid-js/CHEATSHEET.md`.
4. When dev mode prints a `[CODE]` diagnostic: its section in
   `node_modules/solid-js/skills/reactivity-diagnostics/SKILL.md`. Fix the cause, never suppress the code.

## What ships today

The toolchain, lint, these skills, and the SDK's Solid side. A `*.solid.tsx` file compiles with Solid and lints with the
rules below. An extension mounts a Solid component from its `web.tsx` with `island(Component)` from `@/sdk`, and the
component reads documents, UI state and client state as accessors from `@/sdk/solid`
([Solid facets](../../docs/extensions/sdk.md#solid-facets)). The Solid UI kit ships Button, Checkbox, Kbd and KbdGroup,
NumberInput, Popover, Row and Rows, SegmentedControl, Skeleton, Slider, StatusPopoverTrigger (in
`status-trigger.solid.tsx`), Switch and Tooltip. Import from `@/components/ui/<name>.solid.tsx`, and check `web/src/components/ui/` before assuming a component
exists. `extensions/keep-warm/chip.solid.tsx` is the reference migration, with its agent test beside it; the status
chips of setup, mcp, tailscale, push, update, self, pause and sounds followed it. A React point that another extension
renders (mcp's `ExtensionDetails`) stays React and returns an island: `provide(Point, () => <McpDetails />)` with
`const McpDetails = island(Details)`. Icons come
from `@lucide/solid`.

## Ultimate's rules (on top of those skills)

- **One renderer per file.** Solid code lives in `*.solid.tsx` and imports no React, React components or React
  libraries; React files import no Solid and no `*.solid.tsx`, except an extension's `web.tsx`, which imports its
  Solid components to pass them to `island`. The two meet only in `web/src/sdk/island.tsx` and `web/src/sdk/solid.ts`.
  Lint: `ultimate/ui-framework-boundaries`.
- **`@/sdk/solid` in Solid files.** `@/sdk` is React's: its hooks throw or never update in Solid. Import types from it
  with `import type`, everything else from `@/sdk/solid`. Its readers return accessors: call them where you use them
  (`doc()?.title` in JSX or a memo), never once at the top of the component. Lint: `ultimate/ui-framework-boundaries`.
- **Other extensions through their `refs.ts`.** A Solid file reaches another extension's documents and actions
  through its `refs.ts` (browser-safe, renderer-free); its `ui.tsx` is React. Lint: `ultimate/api-only-imports`.
- **ui-sdk only through the UI kit.** Components come from `@/components/ui`, which wraps ui-sdk once and carries our
  theme. For a behavior the kit lacks, build it with `definePrimitive` from `@ui-sdk/core` and add it to the kit.
  Lint: `ultimate/ui-framework-boundaries`, `ultimate/ui-kit-roles`.
- **Our theme, ui-sdk's states.** Style with our tokens (`text-muted-foreground`, `bg-muted`, `border-border/70`,
  `text-brand`) and ui-sdk's state attributes (`data-pressed:`, `data-checked:`, `data-open:`, `data-disabled:`), never
  inline styles for state. The UI stays dense and quiet, with `font-mono` for meta.
- **The pointer cursor is a default.** `web/src/index.css` gives every clickable element (buttons, clickable roles,
  links, labels of controls, `summary`, `select`) the pointer and a disabled one the default cursor; never add
  `cursor-pointer` by hand.
- **Name every control** with a visible label or `aria-label`: people using screen readers and agents both find
  controls by name. Names are unique on the whole page, not just in the component: an agent acts by name, and the
  pause popover's "Play" button, the "Play" chip and "Play by itself after" all matched "Play". Name the action
  (`Play paused work`, `Pause: stop starting new work`).
- **A Solid file reaches another extension's helpers** through its `refs.ts` or a pure `lib/` module. A `.tsx` sibling
  counts as React even without JSX: move data a Solid file needs into a `.ts` file (`extensions/sounds/variants.ts`).
- **Say what agents may do**, as the ui-sdk skill's `references/agent-ready.md` describes:
  `data-agent-confirm="what it does"` on an action that needs a person; `data-agent-secret` on a field an agent may fill
  but never read (password, card and one-time-code fields already are); `data-agent-hidden` on a region agents should
  not see at all; and `agent: { secret: true }` in a `definePrimitive` whose value must never be read.
- **State that should survive** a reload, a restart or a second tab is durable: bind it with `useExtensionUiState` or a
  document from `@/sdk/solid`, not a local signal. Kit controls take it whole: `<Switch bind={digest} />` with
  `const digest = useExtensionUiState('digest', false)` called once in the component body: a Solid prop is a getter,
  so a hook called inside a JSX prop runs again at every read, the change handler's included, and in the browser
  tool's e2e the switch never changed. For an action, pass
  `bind={[() => state().on, (on) => void toggle(on)]}`.
- **Solid 2 facts that tripped agents here** (checked against the pinned version):
  - Stores are copy-on-write: a setter never mutates the object it wraps. But `reconcile` by position adopts the
    incoming objects, so reconciling a value that shares rows with the store's current value (an immutable replica's
    next revision) duplicates rows on a prepend: reconcile a `structuredClone`, as `@/sdk/solid` does.
  - A write inside an owned scope (a component body, a memo, `createRoot(() => …)`) throws
    `REACTIVE_WRITE_IN_OWNED_SCOPE`, tests included: create the store inside the root, write from outside it.
  - A context created without a default throws when nothing provides it, and a provider passing `undefined` counts as
    nothing. For an optional context, declare a `null` default and provide `null`, as `ExtensionName` does.
  - `solid/reactivity` rejects memos built inside an array literal; give each memo its own name. It also needs a named
    variable for merged props before you spread them in JSX.
  - A signal a module shares between mounts (a service worker registration, a subscription) is created inside
    `createRoot` at module scope (`solid/no-module-scope-reactive-primitive`).
  - A value that depends on an answer is a function of it, not a signal an effect copies it into: `useAction`'s
    `every` takes `(data) => ms` (`extensions/mcp/chip.solid.tsx` polls fast while a server connects), never a
    second reader or an effect that writes the interval.
  - Read a callback prop (`props.onValueChange`) into a local before calling it inside `writingAs`, as `Switch` does.
- **ui-sdk facts that tripped agents here:**
  - Popups render in the browser's top layer, not a portal: they stay in their trigger's DOM tree and inherit its
    text styles (a status line's `whitespace-nowrap`, `font-mono`). Kit popups reset the inherited text styles.
  - Button uses `onClick(event, details)`, not `onPress`; return the handler's Promise so ui-sdk tracks its pending
    state. A press itself need not produce a change event; test its callback and the write it starts.
  - Checkbox can report `"indeterminate"`; a boolean `bind` only accepts boolean changes. The SDK indicator sits inside
    the checkbox button and is separate from the native form input.
  - Tooltip needs no provider. `delay` controls hover; keyboard focus opens at once. It keeps `data-slot="tooltip-content"`
    mounted (hidden when closed) so it can name an icon-only trigger before focus. In jsdom, dispatch a Tab `keydown`
    before `.focus()` to test the keyboard path, and `await settle()` for the deferred accessible name.
  - A closed popover hides its controls from the agent bridge: `snapshot()` shows only the popover, so open it first
    (`setOpen(true)` through `act`).
  - Packages that ship raw JSX under the `solid` export condition (ui-sdk, `@lucide/solid`) must be in the Solid
    plugin's `include` in `vite.config.ts`, or Vite compiles them with React's runtime. After changing that list,
    delete `node_modules/.vitest-cache`.
  - Under fake timers `agent.act` never settles: advance timers while it runs (`vi.advanceTimersByTimeAsync`), and do
    not `settle()` under fake timers.
  - Each kit form control a `<label>` wraps goes in `jsx-a11y/label-has-associated-control`'s `controlComponents`.
  - `asChild` is `render`: `<Button render={(props) => <a {...props} href={url}>Open</a>} />`, with the text inside
    the anchor (`jsx-a11y/anchor-has-content` cannot see Button's children).
  - NumberInput's agent `setValue` fires `onValueChange`, not `onValueCommit`; Slider's agent action is `setValue` on
    its labelled thumb.
  - An inline `<svg>` drawing is named by `aria-label` and a `<title>`, not `role="img"` (`jsx-a11y/prefer-tag-over-role`).
- **Lint is the floor, not the bar.** `pnpm check` runs eslint-plugin-solid's `v2-strict` set (Solid 2 semantics) as
  errors, plus accessibility rules and ours, on every `*.solid.tsx`. Never disable a rule inline. A false positive is a
  report to the coordinator, with the code and the rule.

## Testing

- Name a Solid DOM test `*.test.solid.tsx` and open it with the `/** @jsxImportSource @solidjs/web */` pragma; it runs
  in the `solid-dom` Vitest project (jsdom).
- Mount with `renderSolid` from `test/web/solid-dom-setup.ts`, which disposes after each test.
- Reads lag writes: call `flush()` from `solid-js` before asserting, and `await settle()` from `@ui-sdk/core/testing`
  for deferred SDK work.
- For SDK data, mock `web/src/sdk/client.ts` with a real `createStore` on a `FakeSource`, as
  `test/web/solid-sdk.test.solid.tsx` does, and send `doc`/`docOps` events through it. A component that calls
  `useCommands` also needs `registry: createRegistry()` in the mock. Import modules that touch mocked browser globals
  before `vi.useFakeTimers()`.
- The store drops a `system` event whose text equals the last one; a test of a restart or rollback sends a changed
  `system` (a new `booted`), as the server does.
- Agent test: one `createAgent()` (from `@ui-sdk/core/agent`) per file; find controls in `snapshot()` by label and act
  on the ref it returns, never an assumed `c1`, since other controls may mount; subscribe before `act`; assert the
  result's `ok`, the DOM, `details.source === 'agent'` in your handlers, and the events the subscription saw
  (`test/web/solid-harness.test.solid.tsx`). `act`'s `values` are keyed `"<ref> <label>"`. Use `expect(x)` without a
  message: the ui-sdk skill's `expect(x, message)` template fails `vitest/valid-expect`.
- On a whole page, agents drive controls with the browser tool's `ui` steps (`snapshot`, `query`, `act`), which wait
  for the page's first render and for every mounted read's first answer (a request that never reached the server
  counts). A change is recorded only when it reaches stored state: the server emits `ui.changed` in the commit that
  writes a UI-state key or that an action marks with `ctx.uiChanged` (`extensions/ui/README.md`); opening, closing,
  hover and focus are never recorded. Who made it travels as a request header: kit controls run their change handlers
  in `writingAs(details.source, …)` from `@/sdk/solid`, so a write the handler starts synchronously during an agent's
  `act` carries `agent`. A new kit control with a change callback does the same. A write the person didn't make with this action, one a URL,
  a timer, an effect or reconciliation starts, runs in `writingAs('app', …)` and records nothing. `writingAs` holds only for the synchronous call: for a write
  after an `await`, capture the source first and re-enter `writingAs(source, …)` at the write itself, never across
  the `await`. The browser tool sends pending
  UI-state writes before it closes the page, whatever the last step was.
- To type into a ui-sdk text field in jsdom, use `setRangeText` and dispatch `input`, as ui-sdk's own `type` helper
  does: assigning `.value` counts as a program's write, not typing, and reports no `input-change`.
- Read state where it lives. `useAction` follows the shown conversation, so on a fresh page its read switches when the
  view arrives, starts unanswered, and a `<Show when={data()}>` unmounts what an agent was about to act on. State that
  lives on the root reads `useAction(ref, args, { conversation: ROOT })` and `useDocOf(() => ROOT, ref)`.
- A Solid `useAction` with getter args: each read keeps the args its key was made from, so switching args mid-flight
  never answers the old read with the new args.
- A person's click inside `data-agent-hidden` still changes the control, but the bridge reports nothing: a secret
  value an agent may fill goes in `data-agent-secret` instead.

## Measuring the migration

The migration must leave the front end more robust, faster, simpler and smaller. `docs/frontend-baseline.md` holds
the baseline and how each number is measured (`node scripts/frontend-weight.ts`, the `measure-switch` skill); every
step report shows its delta against it.

## Done means

1. `pnpm check` passes.
2. Tests for the behavior, as the ui-sdk skill's testing reference describes.
3. Look at it with the `verify-ui` skill; for a visible change, a preview round.
4. Report anything the skills, docs or types got wrong, so this skill or a lint rule can catch it next time.
