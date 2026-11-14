# Inbox

Everything that waits on the user, oldest first, answered in place: the `inbox` surface, first tab after Agent. Its
items are the messages `waiting` (questions) returns over the Messages log, read live and never copied, merged with
the items other extensions provide (`items.tsx`); a question leaves the moment it is answered or dismissed, wherever
that happened, a provided item when its provider stops listing it. Browser only: no `server.ts`, no documents, no
actions of its own.

## Provided items (`ui.tsx`)

Another extension puts its own things to do in the Inbox (a command to run in a terminal, say) by providing the
`InboxItems` point from its `web.tsx`: `provide(InboxItems, () => items)`, a hook returning
`{ key, at, conversation?, from?, tag, title, gist?, pane }[]`. `key` is unique across providers (`shell:12`), `at`
when it started waiting, `tag` the row's kind tag, `pane` the reading pane's content below the title, its buttons
included; with `conversation` the row names it and the pane offers **Open in branch**; `from` (a node, such as another
project's tile and name) takes the asker's place instead. A pane that asks questions can use questions'
`QuestionsCard` with its own `submit`, `reply` and `dismiss`. Every provider's items count in the
sidebar row and the To-dos' "For you" row too: they all read `Waiting` from `ui.tsx`. A provider that throws is left
out behind its inline error card. Items are entries keyed by string; a question's key is `message:<id>`.

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

`?inbox=<key>` on load opens the surface at that entry and leaves the address; the `inbox:open {key}` event does the
same at runtime (a push notification's tap, `extensions/push`). A plain number, in either or as
`inbox:open {message}`, is a question's message id.

## Elsewhere

- **Sidebar**: a row under @ultimate's (`sidebar.under-ultimate`), amber `Inbox · N · oldest 2h` while items wait,
  a quiet `Inbox` at zero; a click opens the surface. @ultimate's own row then says only `waits on you`.
- **To-dos**: the panel's "For you" keeps one `Inbox · N` row, provided items counted, that opens it.
- ⌘K **Open Inbox**.
