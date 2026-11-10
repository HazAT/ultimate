# To-dos

The project's short list of open loops, each owned by the user or @ultimate. No priorities, due dates, tags or
nesting: for planned work with tasks and reviews, use `plan`.

## State

The `todos` document on conversation 1 (conversation scope, latest history, initial on fork) holds
`{ next, items: [{ id, text, owner: 'user' | 'ultimate', at, done? }] }`, oldest first. Text is trimmed, nonempty
and at most 300 characters. Ticking keeps the newest 50 done items and drops older ones; open items are never dropped.

## Agents

`todo {action: 'add', text, owner} | {action: 'done', id} | {action: 'list'}` belongs to @ultimate: it is deferred
and named in `agents/ultimate.md`, and any other caller is refused. A coordinator that wants something on the list
asks @ultimate.

Whenever the open list changed since @ultimate last heard it, the input that starts its next run goes in after a
`todos.note` entry listing its open to-dos and the user's, by id (`No to-dos are open.` once the last one is ticked).
An unchanged list adds nothing, and the note is never part of the system prompt, so the prompt cache holds.

## Other projects

Each project keeps its own list. Another project's @ultimate reads it with codemode
`ultimate.doc('todos', 1, { project })` (see [codemode](../codemode/README.md#other-projects)) and asks this
project's @ultimate to add one with `ultimate.tell`.

## Panel

The first tab of the right panel: one amber `Inbox · N` row while questions wait on the user (read live from
Messages, never copied; a click opens the Inbox, which lists and answers them), the user's own to-dos, then
@ultimate's, an add field, and the done ones folded away. The header counts questions apart from to-dos. An open to-do's ▶ button (on hover or focus) sends @ultimate, as the
user, `Work on to-do #<id>: <text>` (`Help me with to-do #<id>: …` for the user's own), after its current run if
it is busy, and opens its conversation. ⌘K “Show open questions” opens this tab.

## Actions

All user-only, for the panel.

- `add { text, owner }` → the new to-do.
- `done { id }` → the to-do, ticked.
- `reopen { id }` → the to-do, open again.
