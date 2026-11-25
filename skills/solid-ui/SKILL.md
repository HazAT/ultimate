---
name: solid-ui
description: Write or review Solid 2.0 UI in Ultimate (a `*.solid.tsx` file, a UI kit component, a Solid extension facet) with ui-sdk components and behaviors. Use before writing or changing any `.solid.tsx` file or anything under web/src/components/ui.
---

# Solid UI in Ultimate

Ultimate's UI uses Solid 2.0, with Vercel UI SDK (`@ui-sdk/*`) under its components. Both are newer
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

- **Clean, easy to use, simple, clear, robust.** One primitive in place of hand-made state, a kit control in place of
  a styled element. Size comes second.
- **Durable by default.** State that should survive a reload, a restart or a second tab is a document or UI state, not
  a local signal. Kit controls take it whole through `bind`.
- **Who acted is part of every change.** Kit controls run their handlers in `writingAs(details.source, …)`, so a write
  an agent starts is recorded as the agent's. Keep that path: start writes from a kit control's handler. The page bus
  (`events.emit`) runs its handlers as the writer of the moment, so an event emitted from a handler needs no `source`.
- **Agents are users.** Every control has a unique name, says when it needs a person, and hides what agents must not
  read.
- **Lint is the floor.** `pnpm check` runs eslint-plugin-solid's `v2-strict` set, accessibility rules and ours on every
  `*.solid.tsx`, all as errors. Never disable a rule inline; report a false positive with the code and the rule.

## Where Solid lives

The UI is Solid, and so is every facet: `web.solid.tsx`. A leftover React `web.tsx` loads as an error card
([Moving a React facet to Solid](../../extensions/README.md#moving-a-react-facet-to-solid)).

- **One renderer per file.** Solid JSX belongs in `*.solid.tsx`.
- **One SDK entry: `@/sdk/solid`.** Readers, actions, contexts, formatters and the shared parts (`Header`, `Card`,
  `Fold`, `Slot`, `Provided`, …) all come from it. Inside `web/src`, modules import `web/src/sdk/hooks.ts` instead,
  since the parts the entry re-exports import the readers (`import/no-cycle`). Readers return accessors: call them
  where you use them (`doc()?.title` in JSX or a memo), never once at the top of a component
  ([Solid facets](../../docs/extensions/sdk.md#solid-facets)).
- **Other extensions through their contracts.** A Solid file imports another extension's `refs.ts` (its documents and
  actions) or its `ui.solid.tsx` (its components, such as conversations' `ConversationRef`). Shared data goes in a
  `.ts` file or `lib/` (`lib/conversation-ref.ts`, `extensions/sounds/variants.ts`). Lint: `ultimate/api-only-imports`.
- **Module stores** that several parts read (a cache, a picker's target) live in a `.ts` file as one small cell with
  `get`, `set` and `subscribe`; Solid reads it with a signal set from `subscribe` (`extensions/models/state.ts`,
  `readers.solid.tsx`).
- **Contracts:** `ui.solid.tsx` holds only what other extensions use; a component's implementation can live in its
  own file and be re-exported. A pure `.ts` helper counts as server code to `ultimate/api-only-imports`: it imports
  other extensions' refs only as types, or takes their tokens as arguments (`extensions/activity/events.ts`).
- **Markdown:** the `link`, `inlineCode` and `codeBlocks` renderers are components passed straight to `web.solid.tsx`
  (`extensions/diagrams/mermaid.solid.tsx`). Use `Markdown` and `MentionText` from
  `@/components/markdown/markdown.solid.tsx` to show Markdown and mentions.

## The transcript and points

- **Transcript renderers** are plain components: `entries: { 'my.kind': EntryCard }`, with `EntryCard` taking
  `SolidEntryProps` (`SolidToolProps` for a tool) from `@/sdk/solid`. Read rows with `useTranscript()` and their
  scroll element and container with `useTranscriptElements()`. Use `renderEntry(Token, EntryCard)` to narrow by an
  entry token; give a model-only entry a renderer returning `null`.
- **Transcript parts:** `Card`, `Fold` (its `label` names the toggle), `MessageActions` (`name` names its copy button
  when several cards share an entry), `UserText`, `UserView`, `useToolDuration`. One of each part: before writing a
  card, fold, diff or agent mark, use the shared one (coding-tools' `Diff` from its `ui.solid.tsx`, conversations'
  `AgentMark`).
- **Point providers** use `provide(Point, value)`. Use a component for a UI-valued point: it takes an object input
  as props (`{ conversation }`), and `Provided` renders it under its extension name. Keep UI and data in separate
  points (the sidebar's task data and task chip). A data provider takes an input accessor and returns a value
  accessor. Declare a shared point once and re-export it from `ui.solid.tsx`; built-ins keep definitions in a plain
  `.ts` file (`extensions/conversations/points.ts`) so tests can read them without loading the browser SDK. A core-tier
  reader can't import an optional extension's contract: it declares the point instead.
- **Point and slot readers:** `useProvided` for one data value, `useAllProvided` for every provider's (`Unlisted`),
  `Provided` for UI (`UnderUltimate`, the task chip), and `Slot` for a slot (`sidebar.top`). Read a point once per
  row or list, not per cell.
- **The composer:** a `composer` wrapper takes `SolidComposerProps`, an `inbox` renderer `SolidInboxProps`. Read the
  redirect target with `useContext(ComposerRedirect)` (an accessor) and provide it with
  `<ComposerRedirect value={target}>` around `props.core`.

## The shell

- **The page is Solid.** `web/src/main.solid.tsx` renders `App.solid.tsx`; the title bar, header, status line,
  sidebar region, panels, dock, palette and error stack are Solid (`web/src/app/shell.solid.tsx` and its neighbours).
  A surface builds on `Header`, `StatusLine`, `Conversation`, `Dock`, `Sidebar`, `Panels`, `Slot` and `ErrorCard`
  (`extensions/agent/surface.solid.tsx`).
- **Render registered contributions** through `Contribution`, `Slot` or `Provided`, never by calling the component.
  This gives each contribution its own extension scope and error handling; only the core hosts in `web/src` import
  the bridge (`ultimate/ui-framework-boundaries`).

## The UI kit

ui-sdk is reached only through `web/src/components/ui/*.solid.tsx`, which wraps it once with our theme. Check the folder
before assuming a component exists; for a behaviour the kit lacks, build it with `definePrimitive` from `@ui-sdk/core`
and add it to the kit. Lint: `ultimate/ui-framework-boundaries`, `ultimate/ui-kit-roles` (hand-made widget roles, bare
`<form>`s and bare `<button>`s: the agent bridge sees only kit parts). An unstyled control is `Button` with
`size={null} variant={null}`, which still has the base `inline-flex font-medium whitespace-nowrap`: add `font-normal`
and, for prose or a link in text, `h-auto whitespace-normal text-left` (`inline` for a link), or it changes look.

| Component                                                                      | Notes                                                                                                                                                |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Button                                                                         | `onClick(event, details)`; return the Promise so it shows pending. `render` replaces `asChild`.                                                      |
| Form                                                                           | Never navigates; its `type="submit"` Button's `onClick` submits, which Enter in a field and a Textarea's `submitShortcut` press too.                 |
| Input, SecretInput, Textarea (`input.solid.tsx`)                               | A secret field agents may fill but never read; Textarea's `submitShortcut` presses its form's submit Button.                                         |
| CopyValue                                                                      | A value in a row that copies itself when pressed; `field` names it.                                                                                  |
| Checkbox, Switch, SegmentedControl, Slider, NumberInput                        | Take `bind`. Checkbox may report `"indeterminate"`; NumberInput's agent `setValue` fires `onValueChange`; Slider's agent acts on its labelled thumb. |
| Tabs                                                                           | Name `TabsList`; match `TabsTab` and `TabsPanel` by value. `bind` selects a tab. The bridge lists closed tabs that might hide a control.             |
| Toggle, ToggleGroup                                                            | `bind` tracks pressed state (an array for a group). Use a stable label and `onPressedChange`, not `aria-pressed`.                                    |
| Accordion                                                                      | `bind` takes an array of open item values. Name the root with several items; put each trigger in its item's `AccordionHeader`.                       |
| Collapsible                                                                    | Unmounts its panel when closed; `keepMounted` keeps it.                                                                                              |
| Popover, StatusPopoverTrigger (`status-trigger.solid.tsx`), HoverCard, Tooltip | Popups in the top layer; Tooltip needs no provider.                                                                                                  |
| Dialog, DropdownMenu, Command                                                  | `DialogContent`'s `finalFocus`, menu labels in a group, Command's `filter`: see Pitfalls.                                                            |
| Toast                                                                          | Fed by `createToaster()` (`extensions/notices/toasts.solid.tsx`).                                                                                    |
| Kbd and KbdGroup, Row and Rows, Skeleton                                       | Static parts.                                                                                                                                        |

Icons come from `@lucide/solid`. `extensions/keep-warm/chip.solid.tsx` is a small reference, with its agent test.

## Patterns

- **Durable state:** `const digest = useExtensionUiState('digest', false)` once in the body, then
  `<Switch bind={digest} />`. Never call a hook inside a JSX prop: a Solid prop is a getter, so it runs again at every
  read. For an action: `bind={[() => state().on, (on) => void toggle(on)]}`.
- **Whose key:** `useExtensionUiState` takes the extension name of where it renders, so a part rendered through another
  extension's point (a System tab, the sidebar's `UnderUltimate`) writes under that extension's name: wire's tab once
  wrote its own state over `ext.system.tab`. Such a part uses `useUiState` with an explicit `ext.<own name>.<key>`
  from a shared `.ts` file (`extensions/wire/state.ts`).
- **A durable selection names what is shown.** When the selected row leaves, store the row that took its place, not
  just a rule for finding it again, or a later arrival takes over the pane under the person's cursor
  (`selectionAfterChange` in `extensions/inbox/items.ts`). Order rows with a tie-breaker, never by time alone. An
  effect that repairs stored state writes in `writingAs('app', …)`; UI state never resends an `app` value the server
  refused until a write goes through, the key changes or someone writes it, so the effect needs no guard of its own.
- **Reading the server:** `useAction(ref, args, options)` shares one call per action, args and conversation. `every` takes ms or
  `(data) => ms` (`extensions/mcp/chip.solid.tsx` polls fast while connecting). Every read in use refetches after a
  restart, keeping its last answer meanwhile; on reconnect only active reads that failed with a network error retry.
  `useAction` has no deadline: a read that must give up on a hung request or show nothing from an earlier server
  process keeps its own effect keyed on the connection and generation (`useRates` in
  `extensions/status-line/status.solid.tsx`). A deadline on the shared read was tried and
  dropped: one reader's timeout on a call other readers share kept breaking joins, departures, restarts and readiness. State that lives on the root reads `{ conversation: ROOT }` and `useDocOf(() => ROOT, ref)`,
  since a plain read follows the shown conversation and starts unanswered when the view arrives. A read with getter
  args keeps the args its key was made from. A poll that pauses while the tab is hidden is `every: () => (visible() ?
  ms : undefined)` on a visibility signal, refetching when the tab is shown (`extensions/projects/rail.solid.tsx`).
- **Many owners, one lifetime:** a recording, a capture or a subscription that several handlers and effects must end
  hangs off one `AbortController`: listeners take its `signal`, and the effect keyed on what ends it calls `abort()`
  instead of a ref mirroring state for a cleanup to read.
- **The conversation's model:** `useAgent()`, not a whole conversation replica.
- **Formatting:** `formatAgo`, `formatDuration`, `formatTime`, `formatBytes`, `formatTokens`, `plural`, `shortenPath`,
  `elidePath` and `prettyName` come from `@/sdk/solid`; a shared `.ts` helper takes `formatAgo` and `plural` from
  `lib/`. Never a local copy. A formatter called per row reuses one `Intl` object: `toLocaleTimeString` builds one per
  call, about 15 ms of a warm switch to a lander log before `formatTime` kept two.
- **Writes after an `await`:** `writingAs` holds only for the synchronous call. Take `details.source` before the
  `await` and re-enter `writingAs(source, …)` at the write (`start` in `extensions/todos/panel.solid.tsx`). Deep in a
  helper the handler calls, take `writerNow()` instead (`send` in `web/src/app/composer.solid.tsx`, whose steer awaits
  a withdrawal before it submits). A write the
  person didn't make with this action (a URL, a timer, an effect) runs in `writingAs('app', …)` and records nothing.
- **Forms:** the kit `Form`, with the change started in its submit Button's `onClick`, which receives `details.source`.
  A native `onSubmit` has no source, so an agent's submit would be recorded as the person's. Enter in an Input and
  `submitShortcut` in a Textarea press that Button (`extensions/goal/dialog.solid.tsx`).
- **One row per id:** `mapArray(ids, (id) => …)` gives each id its own owner and reads, disposed when it leaves. A
  polled list whose objects are replaced on each fetch keeps its DOM with `<For keyed={(row) => row.id}>`; with a key
  function both the item and the index are accessors (`index()`).
- **A component that reads a shared service** can take it through a factory at module scope (`readAloudAction(player)`
  in `extensions/read-aloud/web.solid.tsx`). The returned component owns its subscription.
- **Derived values:** a value that depends on an answer is a function of it, never a signal an effect copies it into.
- **Async in the graph:** a one-shot fetch a component owns is a memo returning the Promise, read under `<Errored>`
  and `<Loading on={key}>`. Read every input before the first `await`: later reads are not tracked
  (`UNTRACKED_READ_AFTER_AWAIT`). A newer run only drops the older answer, so abort the request yourself:
  register an `AbortController`'s `abort` with `onCleanup` before the `await` (`MessageImages` in
  `extensions/messages/message-images.solid.tsx`).
- **Server reads stay on `useAction`,** not async memos. It is an external store on purpose: one call per action, args and
  conversation for every reader, polling, revision order, a refetch after a restart, and the readiness the agent bridge
  waits on. Its `loading()` is that store's flag; don't rebuild it on `<Loading>`.
- **Pending:** `isPending(() => value())` is true only while a _new_ answer is in flight; the first load is loading
  (a `<Loading>` fallback or the memo's placeholder), never pending. A widget that must not wait for slower async
  neighbours is a `createDeferred`. A press's own pending belongs to the kit `Button`: return the Promise from
  `onClick`. Keep a `busy` signal only when it also locks other controls.
- **Every change is a transition.** Writes in one tick, and an `action()`'s writes, land together with the async they
  touch. So actions that write shared signals tie independent rows together: optimistic switches over one shared
  list kept a failed row on until another row's request settled, and were reverted (`40fc6170`). Use
  `createOptimistic` + `action` only for a single control with its own state (the rail pin in
  `extensions/projects/rail.solid.tsx`); independent rows keep their own lock and error.
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
  starting new work`). The bridge resolves a name regardless of case and accents: a label that exactly names one
  control wins, and otherwise it matches whole words of a label or row text. So a label may appear inside a longer one
  ("Finished" beside "Play Finished"), but no two controls on the page may share a label (a popover trigger and its
  switch were both "Sounds"; "Resume" and "Résumé"), and an agent naming a control uses its whole label. Cards repeat (two `subagent` calls to one child, a start and a list card of one preview, two codemode results, every
  reply's copy button), so a card's controls name the call or entry they sit on (`Show conversation #34 (call
  1a2b3c4d)`, `Go back to message #812`), options their position (`Option 2 · question 2 · message 2`), and a shared
  part takes an `on` (`TaskChip`) or `name` (`JsonTree`) prop to carry it. A tree names nodes by a path that cannot
  collide: `doc["a.b"]`, not `doc.a.b`. A Tooltip trigger rendered as a `<span>` is not named by its text: give it an
  `aria-label`. Reviews found repeated names in nearly every round.
- **Styling:** our tokens (`text-muted-foreground`, `bg-muted`, `border-border/70`, `text-brand`) and ui-sdk's state
  attributes (`data-pressed:`, `data-checked:`, `data-open:`, `data-disabled:`), never inline styles for state. Dense
  and quiet, `font-mono` for meta. The pointer cursor is a base rule in `web/src/index.css`; never add
  `cursor-pointer`.

## Pitfalls

Solid 2:

- An error no `<Errored>` catches (a render or an effect throwing, apply half included) halts every update on the page.
  Each contribution has its own boundary (`web/src/sdk/contribution.solid.tsx`) and the page has a root one
  (`PageBoundary` in `web/src/app/page-failure.solid.tsx`) with a Reload card; core code under it still freezes until
  reload. Don't catch a reactive read's throw in `try/catch` (`CAUGHT_REACTIVE_READ`).
- The page runs Solid's production build, so `[CODE]` diagnostics show only in tests and the dev server: run the
  tests to see them.
- A write inside an owned scope (a component body, a memo, `createRoot(() => …)`) throws
  `REACTIVE_WRITE_IN_OWNED_SCOPE`, tests included: create the store in the root, write from outside it.
- A context without a default throws when nothing provides it, and providing `undefined` counts as nothing. An optional
  context declares a `null` default (`ExtensionName`).
- A tree that is re-derived from text (parsed Markdown, a fetched list without ids) keeps its DOM through
  `createProjection(fn, seed, { key: null })`: each parse reconciles into the store by position, so only the nodes that
  changed update, with `<For keyed={false}>` over it. A streamed delta then costs about one DOM mutation
  (`web/src/components/markdown/markdown.solid.tsx`).
- A memo over a list a registry rebuilds on every read (`entryRenderers(...)`, `toolRenderers(...)`) changes identity
  each time: give it `equals` comparing the items, or every row below it remounts on each streamed update (11
  remounts per row for one short reply, found with a DOM mutation observer).
- Scroll position is the reader's only when the reader steers: a scroll event alone cannot tell a reader from the
  browser anchoring the view while rows settle after a switch, which once left warm revisits 95 px above the end. The
  transcript's `follow()` (`web/src/app/follow.ts`) unpins only on a scroll that follows a wheel, a pointer or touch on
  the transcript, or a scroll key outside a text field (focus stays on the body after a click, so keys are read on the
  window).
- A Solid setter returns the value it set: as the arrow body of an effect's apply half, that value becomes a cleanup
  the framework calls later (`T is not a function` when `ParkedRuns` set a `Set`). Give the effect a block body.
- Hide a transcript row whose renderer returns nothing with the `empty-row` utility.
- A Web Animation started from a `ref` callback runs before the element is inserted and stays at its first frame in
  Chromium: start it in `onSettled` (`extensions/questions/send.solid.tsx`).
- A control that shows only on hover or focus (`invisible group-hover:visible group-focus-within:visible`, a row's
  `…` menu) is absent from the agent snapshot at rest: an agent focuses the row first. Keep that look rather than
  making the trigger always visible; test the focus-then-open path.
- `expectDistinctAgentNames` is async: `await` it, or the test passes whatever the names.
- Solid sets `href` as given, even for `javascript:` URLs. A link built from tool output or a
  provider's data parses the URL and links only `http(s):`, showing anything else as text
  (`extensions/parallel/calls.solid.tsx`).
- `<For>` over freshly built rows (`Object.entries(value)`, mapped tuples) remounts every row on each update: key it
  (`keyed={(entry) => entry[0]}`), or an expanded branch collapses when a sibling changes
  (`web/src/components/json-tree.solid.tsx`). Then the row is an accessor (`entry()`).
- A `group` state class on a recursive part (`group-data-open/json`) reaches every descendant: an open ancestor
  restyles closed children. Put the group on the node's own trigger and read its `aria-expanded`.
- `import('@lucide/solid/icons')` puts the whole icon set (about 190 KB gzipped) in the page's entry even though it
  is dynamic. Import the icons you need by name from `@lucide/solid`, or use
  `import.meta.glob('…/@lucide/solid/dist/source/icons/*.jsx')` to load one by name.
- `dynamic(() => table[key()][0])` over a plain function rebuilds the component whenever anything it read changes, even
  to the same icon: a lander log's 109 check icons were replaced once more after mount. Make the lookup a `createMemo`
  (`status` in `extensions/workspaces/log-parts.solid.tsx`).
- A part inside a collapsible trigger cannot be a kit `Button` (buttons do not nest): put it beside the trigger, as the
  subagent card's task chip sits next to its open button.
- A kit `Textarea` takes `readonly` (lowercase) and `autoResize` with a CSS `max-h-*`; its agent `setValue` runs the
  field's `onValueChange`, so an agent fill updates a draft store like typing does. Keyboard shortcuts on it
  (Enter, Alt+Enter, ↑) stay a plain `onKeyDown`: `submitShortcut` knows only Enter and mod+Enter.
- A capture-phase listener is a ref callback:
  `ref={(el) => el.addEventListener('keydown', handler, { capture: true })}` (side chat's Tab in `frame.solid.tsx`).
- An attribute built from untrusted input is set as one property, never as a string another value can extend:
  `style={{ 'text-align': align }}`, not ``style={`text-align:${align}`}``.
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
- Start a menu's or a Command's write from its root's `onAction(value, details)`: the kit adds `details.source` and runs
  the handler as that writer. Item `onSelect` takes only an event, so a write started there is always the person's.
  A Command's `onValueChange` is the highlight moving, never activation.
- Command with `filter={false}` and rows the app filters itself: set `autoHighlight={false}` and derive the highlighted
  value (current row, else the first match), or typing leaves the highlight on a footer row
  (`extensions/models/picker.solid.tsx`).
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
- The kit Tooltip opens at once (`delay: 0`); the shell's tooltips pass `delay={400}`. When a `TooltipTrigger` renders
  a kit `Button`, put `onClick` and `aria-label` on the `TooltipTrigger`, which hands them on. On the Button a press
  never reaches the trigger's close, and the tooltip stays open over what the press changed.
- A trigger that renders another part (`TooltipTrigger render={Button}`, `PopoverTrigger render={Button}`) registers
  two agent components with one name in ui-sdk 0.1.0-beta.13: `snapshot()` lists one and a press by label works, but
  `query({ within })` and `expectDistinctAgentNames` find two. It is upstream; don't work around it in the kit.
- Packages shipping raw JSX under the `solid` condition (ui-sdk, `@lucide/solid`) belong in the Solid plugin's `include`
  in `vite.config.ts`; delete `node_modules/.vitest-cache` after changing it.
- Each kit control a `<label>` wraps goes in `jsx-a11y/label-has-associated-control`'s `controlComponents`.
- An inline `<svg>` is named by `aria-label` and a `<title>`, not `role="img"`.
- A refused `act` puts its message in `result.error.message`; `steps` holds only completed ones.

Tooling:

- A browser helper extracted to `.ts` goes in `tsconfig.web.json`'s `include`. Keep shared pure helpers independent
  of the SDK: pass SDK functions in or use `lib/`. Another extension reaches an extension-local browser helper
  through the owner's `ui.solid.tsx` (a re-export is enough: `extensions/system/ui.solid.tsx`), not the `.ts` file.
- A test fixture that registers a facet names it `web.solid.tsx`.
- Check the entry bundle after a change that may grow it: sum the gzipped scripts and styles the page links, on a
  preview of the change and of its parent:

  ```bash
  for a in $(curl -s $URL/ | grep -oE '(src|href)="/[^"]+\.(js|css)"' | cut -d'"' -f2 | sort -u); do
    curl -s $URL$a | gzip -9 | wc -c; done | awk '{s+=$1} END {print int(s/1024) " KB gzip"}'
  ```

## Testing

- **Fewer, meaningful tests.** One agent test per real behaviour of the extension (its action and exact args, its
  confirm gate, its state transition) and one per bug that happened. The kit's tests prove the kit (open, bind,
  attribution); an extension's test does not repeat them. Keep one test file per component group (a chip and its
  popover), not one per case.
- **Files:** `*.test.solid.tsx`, in the `solid-dom` Vitest project (jsdom). Mount with `renderSolid`
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
  changed one. Shared reads outlive a test: seed or refetch per case. A component calling `useAction` needs `reads:
  createReads(api, store)` in the mock (`extensions/info/test/web/panel.test.solid.tsx`).
- **Agents:** one `createAgent()` (from `@ui-sdk/solid/agent`) per file. Find controls in `snapshot()` by label among
  live entries (`!entry.offPage`) and act on the ref it returns; subscribe before `act`. Assert `ok`, the DOM, the
  request's source and the events seen. `act`'s `values` are keyed `"<ref> <label>"`. Call
  `expectDistinctAgentNames(agent)` from `test/web/agent-names.ts` once the component's controls are mounted (popovers
  open). Use `expect(x)` without a message (`vitest/valid-expect`).
- **jsdom limits:** type into a field with `setRangeText` and an `input` event (assigning `.value` is a program's
  write). For keyboard focus on a Tooltip, dispatch a Tab `keydown` before `.focus()`. Modal Tab wrapping, inertness
  and Enter submitting a form need a real browser. `switchConversation` and `showSurface` read `matchMedia`: stub it
  with `vi.stubGlobal` in a test that navigates.
- **A root document in a test** (`ultimate.standing-agents`) reaches `server.of(1)` only once a mounted reader watches
  it: mount first, then send it (`extensions/side-chat/test/web/frame.test.solid.tsx`).
- **Who wrote it, in a preview:** a page the browser tool drives counts every write as the agent's, clicks and keys
  included. Prove a person's attribution in a jsdom test or by the user's own click, not through the browser tool.
- **Whole page:** the browser tool's `ui` steps (`snapshot`, `query`, `act`) wait for the first render and every
  mounted read's first answer, or its first network failure (it stays unsettled): ready to interact does not mean the
  server answered. A change is recorded only when it reaches stored state (`ui.changed`, see
  `extensions/ui/README.md`); opening, closing, hover and focus never are. The browser tool sends pending UI-state
  writes before it closes the page, whatever the last step was. Act on the whole page once in a preview to catch name
  clashes between extensions.

## Measuring

A slower switch is found by what one warm switch does, not by guessing: the `measure-switch` skill's `--profile`, a
DevTools trace of one switch (forced layouts and their stacks). Compare against the parent commit in the same
session: one run's warm median moves 30–50 ms with machine load, so compare interleaved runs of both trees
(`measure-switch`'s `paired.ts`).

## Done means

1. `pnpm check` passes.
2. Tests for the behaviour, as above.
3. Look at it with the `verify-ui` skill. Whether it also needs the user's approval on a preview is the
   `ui-preview-round` skill's call.
4. Report anything the skills, docs or types got wrong, so this skill or a lint rule catches it next time.
