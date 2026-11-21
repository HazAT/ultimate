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
  an agent starts is recorded as the agent's. Keep that path: start writes from a kit control's handler. The page bus
  (`events.emit`) runs its handlers as the writer of the moment, so an event emitted from a handler needs no `source`.
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
- **Module stores** that both renderers read (a cache, a picker's target) live in a `.ts` file as one small cell with
  `get`, `set` and `subscribe`; React reads it with `useSyncExternalStore`, Solid with a signal set from `subscribe`
  (`extensions/models/state.ts`, `readers.solid.tsx`).
- **What moves now:** slot items, panels and overlays of an extension's own (`component: island(SecretsPanel)`). A React
  point another extension renders stays React and returns an island (`provide(ExtensionDetails, …)` in
  `extensions/mcp/web.tsx`). A Solid part that needs what only React reads takes it as a prop from a small React
  wrapper in `web.tsx`; `island` passes props on live, without a remount (`extensions/todos/web.tsx`). A React point
  a moved part reads, it reads with `useProvided` or `Provided` from `@/sdk/parts.solid.tsx` (`Review` in
  `CommitCount`, `extensions/workspaces/ui.solid.tsx`), never through a Solid copy of the point.
- **Contracts:** `ui.solid.tsx` holds only what other extensions use; parts an extension keeps to itself live in their
  own file (`extensions/workspaces/panel.solid.tsx`, re-exported). A pure `.ts` helper counts as server code to
  `ultimate/api-only-imports`: it imports other extensions' refs only as types, or takes their tokens as arguments
  (`extensions/activity/events.ts`).
- **Markdown is Solid** (`web/src/components/markdown/`, step C1): the `link`, `inlineCode` and `codeBlocks` renderers
  are Solid components passed straight to `web.tsx`, without `island` (`extensions/diagrams/mermaid.solid.tsx`).
  React code shows Markdown through `MessageResponse` and `MentionText` from `@/components/ai/message`, islands of the
  Solid renderer (`web/src/sdk/markdown.tsx`); a component an island mounts inside text takes `island(C, { inline:
  true })`, which mounts in a `<span>`. A test that renders React to static markup sees an island empty (it mounts in
  an effect): mock `web/src/sdk/markdown.tsx` there.
- **What waits for the core switch:** `provide` hooks and anything that hosts other extensions' React (the shell, panel
  hosts). The full list is `docs/solid-core-switch.md`; keep it current when you leave a part React.

## The transcript and points across frameworks

- **The transcript is Solid (step C2).** Its renderer points keep their framework: a tool, entry, tool-line, message
  action, message detail, answer label, user bubble or compact summary contributed as `island(C)` renders as plain
  Solid there (`islandSolid` in `web/src/sdk/island-mark.ts`); any other is React and mounts through the temporary
  bridge `web/src/sdk/react-island*.tsx` (C5 deletes it), consecutive React renderers sharing one root around the Solid
  `core`. So moving a row is `entries: { 'my.kind': island(Card) }` with `Card` typed `SolidEntryProps` (`SolidToolProps`
  for a tool) from `@/sdk/solid`. React rows read `useTranscript()` and `useTranscriptScroll()` from one
  `TranscriptFrame` whose identity stays, so a streamed update re-renders none of them; Solid ones read `useTranscript()`
  and `useTranscriptElements()` (the scroll element and the container whose children are rows, no follow state) from `@/sdk/solid`. An entry narrowed by
  its token is `island(renderEntry(Token, Card))` with `renderEntry` from `@/sdk/parts.solid.tsx`; a model-only entry
  still gets a Solid null renderer (a `.solid.tsx` returning `null`), or it mounts React to render nothing.
- **Transcript parts for Solid renderers** come from `@/sdk/parts.solid.tsx`: `Card`, `Fold` (its `label` names the
  toggle), `MessageActions` (`name` names its copy button when several cards share an entry), `UserText`, `UserView`,
  `useToolDuration`, `renderEntry`, `Provided`, `useProvided`. It is a second entry because these parts and the kit
  components they render import `@/sdk/solid`, so `@/sdk/solid` re-exporting them would be an import cycle. One of each
  part: before writing a card, fold, diff or agent mark, use the shared one (coding-tools' `Diff` from its
  `ui.solid.tsx`, conversations' `AgentMark`).
- **Every React renderer costs a React root per row.** The bridge mounts one with `flushSync` for each row a React
  tool, entry or message action renders, and a warm conversation switch mounts them all again: a React message action
  or a React `pi.assistant` wrapper is one root per reply. The step-back after P3 found the warm switch 60 ms slower
  than the React transcript, about half of it in such roots (lineage's go-back action, voice-live's quiet row,
  coding-tools' cards). Move the renderer, even a one-line wrapper, rather than leaving it on the bridge.
- **Points across frameworks.** Read another extension's point in Solid with `Provided` (all providers, or `last`) or
  `useProvided` from `@/sdk/parts.solid.tsx`. A provider written `provide(Point, island(C))` renders as Solid with the
  point's input as props, in Solid hosts and React ones (`<Provided>`, `<AllProvided>`), under its own extension name;
  under `<Provided>` a React hook provider mounts through the bridge with a copy of the input's plain objects and
  arrays taken on any nested change, since board reconciliation updates fields like `message.state` in place;
  `useProvided` passes its accessor's value as it is, so give it plain values. So a point meant for `island(C)` providers takes an
  object input (`{ message }`, `{ conversation }`), and is defined in a `.ts` file both `ui.tsx` and `ui.solid.tsx`
  re-export (`extensions/conversations/points.ts`): a definition reached through `@/sdk` drags browser module-scope
  code into Node tests.
- **React callers of a moved part** (inbox's reading pane, side chat) keep importing it from the owner's `ui.tsx`,
  which exports `island(C)` under the old name; lint allows a `ui.tsx` to import its own `*.solid.tsx`. A React caller
  that styles the part with direct-child selectors (`[&>div]:px-0`) now hits the island's `display: contents` host:
  reach through it (`[&>div>div]`) or pass a `class`. A React caller passing React children into a Solid part cannot:
  keep a small React shell for it (voice-live's `Bubble`).
- **A UI-valued point a Solid host reads** gets its own point whose value is the UI, filled with
  `provide(Point, island(C))` (P3's `ConversationTaskChip`, which plan fills with its chip): a Solid host cannot pick
  `.chip` out of a React provider's `{ chip, title }`. A core-tier reader cannot import an optional extension's
  `ui.solid.tsx` at all, so the point is the only way.
- **A module several frameworks drive** (read-aloud's player) stays one plain module: `web.tsx` hands it to a Solid
  factory at module scope (`const Action = readAloudAction(player)`), and the factory's component subscribes to it.
  That keeps browser-only promises out of a `.ts` file the server lint would check.
- **The sidebar is Solid (step C4b).** It reads every other extension's point through the bridge's public entry,
  `@/sdk/parts.solid.tsx`: `useProvided` for one value, `useAllProvided` for every provider's (`Unlisted`), `Provided`
  for UI another extension draws (`UnderUltimate`, the task chip) and `Slot` for a slot (`sidebar.top`). The bridge file
  itself is only for `web/src`. Each `useProvided`/`useAllProvided` mounts one hidden React root, so read a point once
  per row or once per list, never per cell. A point whose value is a React node (phase's `label`) is read for its plain
  fields only (`word`) and drawn again in Solid; a point that returns UI takes an object input (`{ conversation }`) so
  `Provided` can pass it to `island(C)` providers.
- **The composer is Solid (step C3).** A `composer` wrapper is `island(C)` with `C` typed `SolidComposerProps`, an
  `inbox` renderer `island(C)` with `SolidInboxProps`; read the redirect target with `useContext(ComposerRedirect)`
  (an accessor) and provide it with `<ComposerRedirect value={target}>` around `props.core`. A core host renders every
  contribution only through `Contribution`/`Contributed`/`Slot` from `web/src/sdk/react-island.solid.tsx`, never by
  calling a component itself, so React contributions (outside extensions included) keep mounting through the bridge.
  Solid parts a React contribution places (`core`, `cancel`) go in `Contribution`'s `elements`: the bridge renders each
  with Solid's `render` into the host React places it in, under the placement's conversation scope, and disposes it
  (DOM included) when React removes or hides it. A part React never places never runs.

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
  (`selectionAfterChange` in `extensions/inbox/items.ts`). Order rows with a tie-breaker, never by time alone. An
  effect that repairs stored state writes in `writingAs('app', …)`; UI state never resends an `app` value the server
  refused until a write goes through, the key changes or someone writes it, so the effect needs no guard of its own.
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
  "Finished" also named "Play Finished"; a popover trigger and its switch were both "Sounds"; "Resume" and "Résumé").
  Cards repeat (two `subagent` calls to one child, a start and a list card of one preview, two codemode results, every
  reply's copy button), so a card's controls name the call or entry they sit on (`Show conversation #34 (call
  1a2b3c4d)`, `Go back to message #812`), options their position (`Option 2 · question 2 · message 2`), and a shared
  part takes an `on` (`TaskChip`) or `name` (`JsonTree`) prop to carry it. A tree names nodes by a path that cannot
  collide: `doc["a.b"]`, not `doc.a.b`. A Tooltip trigger rendered as a `<span>` is not named by its text: give it an
  `aria-label`. Both P2 and P3 reviews found repeated names in every round.
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
- A tree that is re-derived from text (parsed Markdown, a fetched list without ids) keeps its DOM through
  `createProjection(fn, seed, { key: null })`: each parse reconciles into the store by position, so only the nodes that
  changed update, with `<For keyed={false}>` over it. A streamed delta then costs about one DOM mutation
  (`web/src/components/markdown/markdown.solid.tsx`).
- A memo over a list a registry rebuilds on every read (`entryRenderers(...)`, `toolRenderers(...)`) changes identity
  each time: give it `equals` comparing the items, or every row below it remounts on each streamed update (C2 found
  11 remounts per row for one short reply with a DOM mutation observer).
- Scroll position is the reader's only when the reader steers: a scroll event alone cannot tell a reader from the
  browser anchoring the view while rows settle after a switch, which once left warm revisits 95 px above the end. The
  transcript's `follow()` (`web/src/app/follow.ts`) unpins only on a scroll that follows a wheel, a pointer or touch on
  the transcript, or a scroll key outside a text field (focus stays on the body after a click, so keys are read on the
  window).
- React mounted inside Solid commits in a later task unless `flushSync`: a Solid effect that measures the React part
  (a reveal finding a tool card inside its row) then sees it empty. The bridge's roots render with `flushSync`.
- A Solid setter returns the value it set: as the arrow body of a React `useLayoutEffect(() => set(v))` or a Solid
  effect's apply half, that value becomes a cleanup the framework calls later (`T is not a function` when `ParkedRuns`
  set a `Set`). Give the effect a block body.
- Unmounting a React root from Solid cleanup that runs inside a React commit (a part React hides) warns and defers:
  unmount it on `nextTurn`.
- A transcript row hides with the `empty-row` utility, which also hides a row whose only child is a React host that
  rendered nothing (`data-empty`); `:empty` alone no longer matches once the bridge wraps React.
- A Web Animation started from a `ref` callback runs before the element is inserted and stays at its first frame in
  Chromium: start it in `onSettled` (`extensions/questions/send.solid.tsx`).
- A control that shows only on hover or focus (`invisible group-hover:visible group-focus-within:visible`, a row's
  `…` menu) is absent from the agent snapshot at rest: an agent focuses the row first. Keep that look rather than
  making the trigger always visible; test the focus-then-open path.
- `expectDistinctAgentNames` is async: `await` it, or the test passes whatever the names.
- React refused `javascript:` URLs in `href`; Solid sets the attribute as given. A link built from tool output or a
  provider's data parses the URL and links only `http(s):`, showing anything else as text
  (`extensions/parallel/calls.solid.tsx`).
- `<For>` over freshly built rows (`Object.entries(value)`, mapped tuples) remounts every row on each update: key it
  (`keyed={(entry) => entry[0]}`), or an expanded branch collapses when a sibling changes
  (`web/src/components/json-tree.solid.tsx`). Then the row is an accessor (`entry()`).
- A `group` state class on a recursive part (`group-data-open/json`) reaches every descendant: an open ancestor
  restyles closed children. Put the group on the node's own trigger and read its `aria-expanded`.
- `import('@lucide/solid/icons')` put the whole icon set (about 190 KB gzipped, measured before P2 landed) in the
  page's entry even though it is dynamic; conversations' `AgentMark` imports `icons` statically today, which C5 trims.
  Name icons statically, or load one by name from `import.meta.glob('…/@lucide/solid/dist/source/icons/*.jsx')`.
- `dynamic(() => table[key()][0])` over a plain function rebuilds the component whenever anything it read changes, even
  to the same icon: a lander log's 109 check icons were replaced once more after mount. Make the lookup a `createMemo`
  (`status` in `extensions/workspaces/log-parts.solid.tsx`).
- A part inside a collapsible trigger cannot be a kit `Button` (buttons do not nest): put it beside the trigger, as the
  subagent card's task chip sits next to its open button.
- A Solid part handed to React for it to place is a `SolidPart` (`solidPart` in `web/src/sdk/react-island.solid.tsx`),
  mounted with `render` at React's host: a bare `insert` there misses event delegation once React portals it, and a
  part built before React decides to place it keeps running hidden (a composer taking drops).
- A kit `Textarea` takes `readonly` (lowercase) and `autoResize` with a CSS `max-h-*`; its agent `setValue` runs the
  field's `onValueChange`, so an agent fill updates a draft store like typing does. Keyboard shortcuts on it
  (Enter, Alt+Enter, ↑) stay a plain `onKeyDown`: `submitShortcut` knows only Enter and mod+Enter.
- A capture-phase listener (`onKeyDownCapture` in React) is a ref callback:
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
- A Solid dialog opened from a React Radix modal (Get ready's Connect, an editor's Configure) sits under the modal's
  focus trap and pointer lock. The opener steps aside while that one child is open (keyed on the child's dialog id, not
  on any open dialog: a stale flag would hide it) and restores focus to its button
  (`extensions/onboarding/pages.tsx`, `extensions/automations/form.solid.tsx`).
- Tooltip keeps its content mounted (hidden) so it can name an icon-only trigger; keyboard focus opens it at once.
- Packages shipping raw JSX under the `solid` condition (ui-sdk, `@lucide/solid`) belong in the Solid plugin's `include`
  in `vite.config.ts`; delete `node_modules/.vitest-cache` after changing it.
- Each kit control a `<label>` wraps goes in `jsx-a11y/label-has-associated-control`'s `controlComponents`.
- An inline `<svg>` is named by `aria-label` and a `<title>`, not `role="img"`.
- A refused `act` puts its message in `result.error.message`; `steps` holds only completed ones.

Tooling:

- A browser helper extracted to `.ts` goes in `tsconfig.web.json`'s `include`. A `.ts` helper shared by React and Solid
  imports neither SDK entry: pass SDK functions in or use `lib/`. Another extension's Solid code reaches it through the owner's
  `ui.solid.tsx` (its React code through `ui.tsx`) (a re-export is enough: `extensions/system/ui.solid.tsx`), never by importing the `.ts` file.
- Check the entry bundle after a move (`node scripts/frontend-weight.ts`, `entryAssetsGzip`); measure each commit in a
  throwaway detached worktree to find the one that grew it.

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

`docs/frontend-baseline.md` holds the baseline and how each number is measured (`node scripts/frontend-weight.ts`, the
`measure-switch` skill); each step appends its entry to `docs/frontend-progress.json` with
`scripts/frontend-progress.ts` and reports its delta.

A slower switch is found by what one warm switch does, not by guessing: the `measure-switch` skill's `--profile`, a
DevTools trace of one switch (forced layouts and their stacks, `Commit` time), and a count of React roots the bridge
mounts. Compare against the parent commit in the same session: one run's warm median moves 30–50 ms with machine
load, so read three runs of each tree, interleaved.

## Done means

1. `pnpm check` passes.
2. Tests for the behaviour, as above.
3. Look at it with the `verify-ui` skill; for a visible change, a preview round.
4. Report anything the skills, docs or types got wrong, so this skill or a lint rule catches it next time.
