# Inbox

Everything that waits on the user, oldest first, answered in place: the `inbox` surface, first tab after Agent. Its
items are exactly the messages `waiting` (questions) returns over the Messages log, read live and never copied
(`items.ts`); an item leaves the moment it is answered or dismissed, wherever that happened. Browser only: no
`server.ts`, no documents, no actions of its own.

## Surface (`web.tsx`)

- **List**: one row per item, the asking branch's feature chip and `#id` as the sidebar draws them, a `preview` tag
  when the text links to a local preview (`http://127.0.0.1:…` or `localhost`), else `question`; the message's bold
  lead or first line as its title, its first question as the gist, and how long it has waited, amber past an hour.
- **Reading pane** for the selected item: the title, the rest of the text (messages' `Body`), its forwarded images
  (`MessageImages`), **Open preview** (a new tab) when it links one, **Open in branch #id** (messages'
  `messages:open {conversation, message}`), and the answer card itself (questions' `MessageQuestions`). When the shown
  item leaves, the one that took its place, the next oldest, shows.
- **Keys** (desktop): `j`/`k` move the selection, `⇧O` opens the branch (plain `o` is the card's "Something else…"),
  and the card's own keys (1–9, letters, ↵, ⇧↵) answer the shown item: the Inbox passes `keys` to the card. A
  branch's transcript keeps its own rule (`keyCard`) when the Inbox is not on screen.
- **Phone**: the list full width; a tap shows the item full screen with a back arrow, the answer card after the text.
- **Zero**: "Nothing waits on you", the questions answered or dismissed today, and **Back to @ultimate**.

`?inbox=<message>` on load opens the surface at that item and leaves the address; the `inbox:open {message}` event
does the same at runtime (a push notification's tap, `extensions/push`).

## Elsewhere

- **Sidebar**: a row under @ultimate's (`sidebar.under-ultimate`), amber `Inbox · N · oldest 2h` while items wait,
  a quiet `Inbox` at zero; a click opens the surface. @ultimate's own row then says only `waits on you`.
- **To-dos**: the panel's "For you" keeps one `Inbox · N` row that opens it.
- ⌘K **Open Inbox**.
