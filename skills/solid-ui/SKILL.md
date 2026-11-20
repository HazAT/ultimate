---
name: solid-ui
description: Write or review Solid 2.0 UI in Ultimate (a `*.solid.tsx` file, a UI kit component, a Solid extension facet) with ui-sdk components and behaviors. Use before writing or changing any `.solid.tsx` file or anything under web/src/components/ui, and when moving a React component to Solid.
---

# Solid UI in Ultimate

Ultimate's UI is moving from React to Solid 2.0, with Vercel UI SDK (`@ui-sdk/*`) under its components. Both are newer
than most models' training data, and Solid 2.0 is not Solid 1.x, so habits from either are the main source of bugs.
The libraries ship skills that match the pinned versions: read them, not your memory.

## Read first (in the Ultimate clone)

1. `node_modules/solid-js/skills/solid-2.0/SKILL.md`: the three rules and the Solid 1.x names that no longer exist.
   Read it every time before you write Solid.
2. `node_modules/@ui-sdk/core/skills/ui-sdk/SKILL.md`: composing ui-sdk, making it agent-ready and testing it. Our
   framework is `solid`; its docs index is `node_modules/@ui-sdk/solid/docs/llms.txt`. Open only the pages you use.
3. An unfamiliar name: `node_modules/solid-js/CHEATSHEET.md`.
4. A `[CODE]` diagnostic in dev mode: its section in `node_modules/solid-js/skills/reactivity-diagnostics/SKILL.md`. Fix
   the cause, never suppress the code.

## Principles

- **Clean, easy to use, simple, clear, robust.** A move to Solid earns its place by reading cleaner: one primitive in
  place of hand-made state, a kit control in place of a styled element. Size comes second; a plain translation is not
  the goal.
- **Durable by default.** State that should survive a reload, a restart or a second tab is a document or UI state, not
  a local signal. Kit controls take it whole through `bind`.
- **Who acted is part of every change.** Kit controls run their handlers in `writingAs(details.source, …)`, so a write
  an agent starts is recorded as the agent's. Keep that path: start writes from a kit control's handler.
- **Agents are users.** Every control has a unique name, says when it needs a person, and hides what agents must not
  read.
- **Lint is the floor.** `pnpm check` runs eslint-plugin-solid's `v2-strict` set, accessibility rules and ours on every
  `*.solid.tsx`, all as errors. Never disable a rule inline; report a false positive with the code and the rule.

## Where Solid lives

- **One renderer per file.** Solid code is in `*.solid.tsx`, opens with `/** @jsxImportSource @solidjs/web */`, and
  imports no React. React files import no Solid, except an extension's `web.tsx`, which mounts Solid components with
  `island(Component)` from `@/sdk`. The two meet only in `web/src/sdk/island.tsx` and `web/src/sdk/solid.ts`. Lint:
  `ultimate/ui-framework-boundaries`, `ultimate/solid-jsx-pragma`.
- **`@/sdk/solid` in Solid files.** `@/sdk` is React's; take only types from it with `import type`. Its readers return
  accessors: call them where you use them (`doc()?.title` in JSX or a memo), never once at the top of a component
  ([Solid facets](../../docs/extensions/sdk.md#solid-facets)).
- **Other extensions through their contracts.** A Solid file imports another extension's `refs.ts` (its documents and
  actions) or its `ui.solid.tsx` (its Solid components, such as conversations' `ConversationRef`); its `ui.tsx` is
  React. A `.tsx` sibling counts as React even without JSX: data a Solid file shares goes in a `.ts` file or `lib/`
  (`lib/conversation-ref.ts`, `extensions/sounds/variants.ts`). Lint: `ultimate/api-only-imports`.
- **What moves now:** slot items, panels and overlays of an extension's own (`component: island(SecretsPanel)`). A React
  point another extension renders stays React and returns an island (`provide(ExtensionDetails, …)` in
  `extensions/mcp/web.tsx`). A Solid part that needs what only React reads takes it as a prop from a small React
  wrapper in `web.tsx`; `island` passes props on live, without a remount (`extensions/todos/web.tsx`).
- **What waits for the core switch:** tool, entry, code-block and user-bubble renderers, message actions and details,
  the composer wrapper, `link`, `provide` hooks, and anything that hosts other extensions' React. The full list is
  `docs/solid-core-switch.md`; keep it current when you leave a part React.

## The UI kit

ui-sdk is reached only through `web/src/components/ui/*.solid.tsx`, which wraps it once with our theme. Check the folder
before assuming a component exists; for a behaviour the kit lacks, build it with `definePrimitive` from `@ui-sdk/core`
and add it to the kit. Lint: `ultimate/ui-framework-boundaries`, `ultimate/ui-kit-roles` (hand-made widget roles and
bare `<form>`s).

| Component                                                                      | Notes                                                                                                                                                |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Button                                                                         | `onClick(event, details)`; return the Promise so it shows pending. `render` replaces `asChild`.                                                      |
| Form                                                                           | Never navigates; its `type="submit"` Button's `onClick` submits, which Enter in a field presses too.                                                 |
| Input, SecretInput (`input.solid.tsx`)                                         | A secret field agents may fill but never read.                                                                                                       |
| Checkbox, Switch, SegmentedControl, Slider, NumberInput                        | Take `bind`. Checkbox may report `"indeterminate"`; NumberInput's agent `setValue` fires `onValueChange`; Slider's agent acts on its labelled thumb. |
| Collapsible                                                                    | Unmounts its panel when closed; `keepMounted` keeps it.                                                                                              |
| Popover, StatusPopoverTrigger (`status-trigger.solid.tsx`), HoverCard, Tooltip | Popups in the top layer; Tooltip needs no provider.                                                                                                  |
| Dialog, DropdownMenu, Command                                                  | `DialogContent`'s `finalFocus`, menu labels in a group, Command's `filter`: see Pitfalls.                                                            |
| Toast                                                                          | Fed by `createToaster()` (`extensions/notices/toasts.solid.tsx`).                                                                                    |
| Kbd and KbdGroup, Row and Rows, Skeleton                                       | Static parts.                                                                                                                                        |

Icons come from `@lucide/solid`. `extensions/keep-warm/chip.solid.tsx` is the reference migration, with its agent test.

## Patterns

- **Durable state:** `const digest = useExtensionUiState('digest', false)` once in the body, then
  `<Switch bind={digest} />`. Never call a hook inside a JSX prop: a Solid prop is a getter, so it runs again at every
  read. For an action: `bind={[() => state().on, (on) => void toggle(on)]}`.
- **Whose key:** `useExtensionUiState` takes the extension name of where it renders, so a part rendered through another
  extension's point (a System tab, the sidebar's `UnderUltimate`) writes under that extension's name: wire's tab once
  wrote its own state over `ext.system.tab`. Such a part uses `useUiState` with an explicit `ext.<own name>.<key>`
  from a `.ts` file that its React and Solid sides share (`extensions/wire/state.ts`).
- **A durable selection names what is shown.** When the selected row leaves, store the row that took its place, not
  just a rule for finding it again, or a later arrival takes over the pane under the person's cursor
  (`selectionAfterChange` in `extensions/inbox/items.ts`). Order rows with a tie-breaker, never by time alone.
- **Reading the server:** `useAction(ref, args, options)` shares one call per action, args and conversation. `every` takes ms or
  `(data) => ms` (`extensions/mcp/chip.solid.tsx` polls fast while connecting). Every read in use refetches after a
  restart, keeping its last answer meanwhile; on reconnect only active reads that failed with a network error retry.
  `useAction` has no deadline: a read that must give up on a hung request or show nothing from an earlier server
  process keeps its own effect keyed on the connection and generation (`useRates` in
  `extensions/status-line/status.solid.tsx`). A deadline on the shared read was tried in the 0.8 step-back and
  dropped: one reader's timeout on a call other readers share kept breaking joins, departures, restarts and readiness. State that lives on the root reads `{ conversation: ROOT }` and `useDocOf(() => ROOT, ref)`,
  since a plain read follows the shown conversation and starts unanswered when the view arrives. A read with getter
  args keeps the args its key was made from. A poll that pauses while the tab is hidden is `every: () => (visible() ?
  ms : undefined)` on a visibility signal, refetching when the tab is shown (`extensions/projects/rail.solid.tsx`).
- **Many owners, one lifetime:** a recording, a capture or a subscription that several handlers and effects must end
  hangs off one `AbortController`: listeners take its `signal`, the effect keyed on what ends it calls `abort()`
  (`extensions/voice/button.solid.tsx`), instead of a ref mirroring state for a cleanup to read.
- **The conversation's model:** `useAgent()`, not a whole conversation replica.
- **Writes after an `await`:** `writingAs` holds only for the synchronous call. Take `details.source` before the
  `await` and re-enter `writingAs(source, …)` at the write (`start` in `extensions/todos/panel.solid.tsx`). A write the
  person didn't make with this action (a URL, a timer, an effect) runs in `writingAs('app', …)` and records nothing.
- **Forms:** the kit `Form`, with the change started in its submit Button's `onClick`, which receives `details.source`.
  A native `onSubmit` has no source, so an agent's submit would be recorded as the person's.
- **One row per id:** `mapArray(ids, (id) => …)` gives each id its own owner and reads, disposed when it leaves. A
  polled list whose objects are replaced on each fetch keeps its DOM with `<For keyed={(row) => row.id}>`; with a key
  function both the item and the index are accessors (`index()`).
- **Derived values:** a value that depends on an answer is a function of it, never a signal an effect copies it into.
- **Effects:** the apply half is untracked, so reading an accessor there trips `STRICT_READ_UNTRACKED` and never
  updates. Read each field you use in the compute half and hand the apply half a plain value
  (`extensions/sounds/player.solid.tsx`); never `snapshot()` there, it subscribes to nothing nested.
- **One-time page work** (a service worker, a URL parameter read once) goes in `onSettled`
  (`extensions/share/receive.solid.tsx`).
- **Coming and going lists** are a kit `Toast` with a `createToaster()`: it owns duration, pause on hover or focus,
  `maxVisible` and dismissal. The agent sees one `toast` component for the region (labelled with the region's name
  only when two or more show) and dismisses one with `press` and its close button's text as the argument; name close
  buttons by their toast (`Dismiss notice <id>: <message>`).
- **Agent permissions:** `data-agent-confirm="what it does"` on an action that needs a person; `data-agent-secret` on a
  field an agent may fill but never read; `data-agent-hidden` on a region agents should not see (a person's click there
  still works, but the bridge reports nothing); `agent: { secret: true }` in a `definePrimitive` whose value must never
  be read.
- **Names:** every control has a visible label or `aria-label` naming its action (`Play paused work`, `Pause: stop
  starting new work`). The bridge resolves a name as whole words of a label or row text, regardless of case and
  accents, so no name on the page may appear as whole words in another ("New to-do" also named "New to-do for";
  "Finished" also named "Play Finished"; a popover trigger and its switch were both "Sounds"). A Tooltip trigger
  rendered as a `<span>` is not named by its text: give it an `aria-label`.
- **Styling:** our tokens (`text-muted-foreground`, `bg-muted`, `border-border/70`, `text-brand`) and ui-sdk's state
  attributes (`data-pressed:`, `data-checked:`, `data-open:`, `data-disabled:`), never inline styles for state. Dense
  and quiet, `font-mono` for meta. The pointer cursor is a base rule in `web/src/index.css`; never add
  `cursor-pointer`.

## Pitfalls

Solid 2:

- A write inside an owned scope (a component body, a memo, `createRoot(() => …)`) throws
  `REACTIVE_WRITE_IN_OWNED_SCOPE`, tests included: create the store in the root, write from outside it.
- A context without a default throws when nothing provides it, and providing `undefined` counts as nothing. An optional
  context declares a `null` default (`ExtensionName`).
- `reconcile` by position adopts incoming objects: reconcile a `structuredClone` when the value shares rows with the
  store's current one (as `@/sdk/solid` does).
- `solid/reactivity` rejects memos inside an array literal and spreading unnamed merged props: name each.
- A signal several mounts share is created in `createRoot` at module scope
  (`solid/no-module-scope-reactive-primitive`).
- Read a callback prop into a local before calling it inside `writingAs`, as `Switch` does.
- ARIA states take strings (`aria-pressed="true"`), not booleans.

ui-sdk:

- Popups render in the top layer inside their trigger's DOM, inheriting its text styles; kit popups reset them.
- A closed popover hides its controls from the agent bridge: open it first (`setOpen(true)`). For a menu or dialog,
  `press` with an inner action's text opens it; a destructive item needs a `confirm` sentence, checked before the
  press.
- `DropdownMenuLabel` goes inside `DropdownMenuGroup` or `DropdownMenuRadioGroup`; the SDK throws otherwise.
- Menu and Command `onAction` details have an optional `event` and no `source`; item `onSelect` takes only an event.
  Their open, radio value and query callbacks do carry `details.source`.
- Command filters `fuzzy` by default, keywords included; items with long `keywords` want `filter="contains"` (the skill
  picker). `label` is what search matches; the bridge names an item by its rendered text. `CommandEmpty` stays mounted
  with `data-empty`; the kit hides it with `not-data-empty:hidden`.
- Focus after a dialog closes elsewhere than the opener: `DialogContent`'s `finalFocus` as a function that resolves the
  element then, from a remembered id, not a kept node (the composer remounts), falling back to the shown
  conversation, since a command or `useDialog` opening it never calls `onOpenChange(true)`. Target an element a person
  can reach (`uncoveredComposer()`, not a composer behind a side chat) and look it up in an effect on the controlled
  `open`, before the modal makes the page inert, and write to that element's own conversation
  (`dataset.conversation`). Focusing in `onOpenChangeComplete` loses to the SDK's own return to the trigger.
- The installed Solid SDK documents agent permissions in `docs/agents.md#permissions`.
- Tooltip keeps its content mounted (hidden) so it can name an icon-only trigger; keyboard focus opens it at once.
- Packages shipping raw JSX under the `solid` condition (ui-sdk, `@lucide/solid`) belong in the Solid plugin's `include`
  in `vite.config.ts`; delete `node_modules/.vitest-cache` after changing it.
- Each kit control a `<label>` wraps goes in `jsx-a11y/label-has-associated-control`'s `controlComponents`.
- An inline `<svg>` is named by `aria-label` and a `<title>`, not `role="img"`.
- A refused `act` puts its message in `result.error.message`; `steps` holds only completed ones.

Tooling:

- A browser helper extracted to `.ts` goes in `tsconfig.web.json`'s `include`. A `.ts` helper shared by React and Solid
  imports neither SDK entry: pass SDK functions in or use `lib/`.

## Testing

- **Fewer, meaningful tests.** One agent test per real behaviour of the extension (its action and exact args, its
  confirm gate, its state transition) and one per bug that happened. The kit's tests prove the kit (open, bind,
  attribution); an extension's test does not repeat them. Keep one test file per component group (a chip and its
  popover), not one per case.
- **Files:** `*.test.solid.tsx` with the JSX pragma, in the `solid-dom` Vitest project (jsdom). Mount with `renderSolid`
  from `test/web/solid-dom-setup.ts`, which disposes after each test. Import only browser-safe helpers from `test/web`;
  `test/helpers.ts` imports the server and fails the web type check (lint:
  `ultimate/no-server-helpers-in-web-tests`).
- **Timing:** reads lag writes: `flush()` from `solid-js` before asserting, `await settle()` from
  `@ui-sdk/core/testing` for deferred SDK work, but not under fake timers. Under fake timers `agent.act` never settles
  by itself: advance timers while it runs (`vi.advanceTimersByTimeAsync`). Import modules that touch mocked browser
  globals before `vi.useFakeTimers()`.
- **SDK data:** mock `web/src/sdk/client.ts` with a real `createStore` on a `FakeSource` and `fakeSubscriptions`
  (`test/web/fake-source.ts`), and send `doc`/`docOps` to the subscription that reads the kind. Add `registry:
  createRegistry()` for `useCommands`. The store drops a `system` event equal to the last one: a restart test sends a
  changed one. Shared reads outlive a test: seed or refetch per case.
- **Agents:** one `createAgent()` (from `@ui-sdk/solid/agent`) per file. Find controls in `snapshot()` by label among
  live entries (`!entry.offPage`) and act on the ref it returns; subscribe before `act`. Assert `ok`, the DOM, the
  request's source and the events seen. `act`'s `values` are keyed `"<ref> <label>"`. Call
  `expectDistinctAgentNames(agent)` from `test/web/agent-names.ts` once the component's controls are mounted (popovers
  open). Use `expect(x)` without a message (`vitest/valid-expect`).
- **jsdom limits:** type into a field with `setRangeText` and an `input` event (assigning `.value` is a program's
  write). For keyboard focus on a Tooltip, dispatch a Tab `keydown` before `.focus()`. Modal Tab wrapping, inertness
  and Enter submitting a form need a real browser.
- **Whole page:** the browser tool's `ui` steps (`snapshot`, `query`, `act`) wait for the first render and every
  mounted read's first answer, or its first network failure (it stays unsettled): ready to interact does not mean the
  server answered. A change is recorded only when it reaches stored state (`ui.changed`, see
  `extensions/ui/README.md`); opening, closing, hover and focus never are. The browser tool sends pending UI-state
  writes before it closes the page, whatever the last step was. Act on the whole page once in a preview to catch name
  clashes between extensions.

## Measuring

`docs/frontend-baseline.md` holds the baseline and how each number is measured (`node scripts/frontend-weight.ts`, the
`measure-switch` skill); each step appends its entry to `docs/frontend-progress.json` with
`scripts/frontend-progress.ts` and reports its delta.

## Done means

1. `pnpm check` passes.
2. Tests for the behaviour, as above.
3. Look at it with the `verify-ui` skill; for a visible change, a preview round.
4. Report anything the skills, docs or types got wrong, so this skill or a lint rule catches it next time.
