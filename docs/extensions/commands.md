# Commands

Part of the [extension guide](../../extensions/README.md).

Entries of the command palette (`mod+k`), optionally with a shortcut. `mod` is ⌘ on macOS and Ctrl elsewhere. Most
commands need none: the palette finds them by title.

```tsx
commands: [
  { id: 'hello.compact', title: 'Compact now', keys: 'mod+shift+c', run: () => api.compact() },
]
```

`run(context)` gets the shell actions (below), the shown `conversationId` (the scoped one for a shortcut typed inside a
`ConversationScope`), and the shown `surface` id; return a promise
to have a failure reported as a notice. `when(context)` hides the command when it returns false, such as
`when: (context) => context.surface === 'commits'` for a command of one surface; a `when` that throws hides it too and
reports a notice naming your extension. Contextual commands can receive an `entryId` alongside `conversationId`
through `useCommands()`; a message-action component can pass its entry's id to a command. Commands run outside components: read the current state with
`getConversation(context.conversationId)` and `getState()`, not hooks, and act on `context.conversationId`.

Plain keys and Shift+letter never fire while the user types; chords with `mod`, `alt`, or `ctrl` do. A plain key that
must work in the composer too sets `whileTyping: true`, as Escape (`agent.stop`) and Shift+Tab
(`model.thinking.cycle`) do; it fires while the user types in the composer, not in other inputs, and still leaves the
key to an open dialog, which closes or moves focus with it.

## Who gets a key

Every shortcut on the page goes through one registry, ui-sdk's, which commands' `keys` join. A key reaches the first
of these that wants it:

1. The focused field, when it handles the key itself and calls `preventDefault` (Escape in a line comment, ↑ in the
   composer). A prompt box leaves Escape alone while something holds it (2).
2. The topmost open layer: a popup closes on Escape, and something pending that Escape cancels claims it with
   `holdEscape(cancel)` from `@/sdk/solid` while it lasts (a screen recording, a dictation take). One press cancels
   once: held down, it reaches nothing beneath until the key comes up.
3. The newest matching shortcut whose `when` holds, registered with `useShortcut(keys, run, options)` in a component
   or `registerShortcut` (both `@/sdk/solid`; ui-sdk parts that register their own, such as a toast region's F6, join the same list), over a command's (an answer's undo window over Escape's stop). A modal
   dialog pauses page shortcuts, except one whose `layer` is in it. Keys match what a key types, not where it sits,
   so `mod+k` is the key labelled K on any layout; `chordOf(event)` spells a press that way, `sameKeys` compares two.

So Escape cancels a recording before it stops the run. Never listen for `keydown` on `window` or `document` to take a
key: register it, and `shortcuts.list()` names it in the System surface's Shortcuts tab. Two keys stay outside the
registry: the splash screen holds every key while it shows, and hold-to-talk listens for the release of its key. To let a command open UI an extension renders, such as a
popover, use a dialog id: the command calls `context.open(id)` and the component reads `useDialog(id)` as its open state
(see `models`).

Command ids are global and resolve like surface ids: a later facet in discovery order wins an id, in the place of the
command it replaces. The shell itself has only the palette (`ultimate.palette`), the panel and sidebar toggles
(`ultimate.panel`, `ultimate.sidebar`), and a `ultimate.surface.<id>` switch per surface; the conversation commands
(stop, compact, focus the composer, show the main conversation) come from `agent`, the theme toggle from `theme`. To
replace one, declare its id; to drop it, replace or delete its extension.
