Read a markdown file beside the conversation you came from, and send the agent one review of the passages you marked.

# Reader

Off by default (`defaultOff` in `shared/extension-api.ts`); turn it on with `"extensions": { "enable": ["reader"] }` in
`~/.ultimate/settings.json` or the project's `.ultimate/settings.json`. It needs Review, whose `send` action delivers
the comments and whose types they share.

## Opening a file

- **From chat**: an inline code span holding a markdown path (`docs/plan.md`, with `:12`, `:12-14` or `#L12`) and a
  link whose href is an absolute path to a `.md` file open it at that line. Web links stay as they are. Chat's link
  hardening blocks a plain relative href before any renderer sees it, so from chat only code spans and absolute-path
  links open.
- **Inside a read file**: relative links are rewritten to the file's real absolute folder before rendering
  (`blocks.ts` `localLinks`, on the parsed Markdown, so code spans and fences stay as written). A link to a markdown
  file opens it in the same root, never a copy at the same relative path in another checkout; a local link to
  anything else shows as text.
- **From a card**: the `file:line` chips of a review sent from the reader show the relative path and reopen the
  absolute file named in the review's spec at that line (`blocks.ts` `chipTarget`).
- **⌘K "Read markdown file…"**: the checkout's markdown files, newest first, or a typed path.
- **Address**: `/?read=<path>[&line=N]`, and the address carries `?read=` while Read is on screen.
  `events.emit('reader:open', { path, line? })` does the same from code (`openReader` in `link.solid.tsx`). The file
  shown belongs to the tab: opening a file in another tab never moves this one. The last file opened is shared only
  as the starting point for a tab that has none yet.

The **Read** surface shows the file in a reading column, split into the blocks chat's Markdown splits it into and each
rendered by chat's `Markdown`, with a conversation docked on the right (on a phone, the header's `#id` button switches
to it): the file's thread once it has one, else the shown conversation. YAML front matter shows as a small muted
block. The file is read again whenever the docked conversation's transcript changes and when the window regains
focus, so the agent's edits show while you read.

## A thread per file

Opening a file starts nothing. The first Send on a file starts its **thread**: a lineage branch of the conversation
the file was opened from (the shown one), whose first input is that Send's review, so it carries only the comments on
that file. From then on the reader docks the thread whenever it shows that file, whichever conversation is shown, and
every Send on the file goes to it. Threads are kept by the file's absolute path in the `reader.threads` document on
the root conversation (`threads.ts`, `server.ts` `thread`). A thread whose conversation is gone is replaced by a new
branch on the next Send. With a thread, the file is read from the conversation the thread branched from.

The branch is made through lineage's `branch` service with `deliver: false`: a fork of that conversation at its latest
entry, inheriting its history (from a root, its memory brief instead), model and thinking level, in the project root
without a worktree, and its prompt names the file. The footer's button reads `Send to new thread` until then,
`Send to #<id>` after.

## Comments

Select text in one or more blocks and press **Comment** (in the margin beside the selection, or a pill at the bottom on
narrow screens). The comment covers the source lines the selection spans (`blocks.ts` `selectedLines`); its excerpt is
the selected text, capped like Review's (40 lines, 8 KB). **Add comment** (⌘↵) pins a draft under the block, editable
and deletable; **Cancel** or Escape closes the composer. While a comment is being written, Comment and the other
comments' Edit are off, saying to save or cancel it first.

Drafts live in this browser's local storage, one key per comment and one for the note:
`ultimate.reader.drafts:<absolute path>:<comment id>` and `…:<absolute path>:note`, one set per file whichever
conversation shows it, since the file has one thread. No write reads and rewrites a shared value, so two tabs only
write the same key when they edit the same comment; other tabs refresh on the `storage` event. The comment being
written is saved on every change under `…:<absolute path>:writing:<tab>` (one slot per tab, its id kept in session
storage), so it comes back after a surface switch or a reload and two tabs never type over each other's. A write the
browser refuses (storage full) keeps the text in its composer or note box, marked not saved, and held in this tab's
memory until a later write of the same key succeeds.

The file is known by its real absolute path once read: re-reads, reopening and draft keys use it, so the same relative
path in the conversation's worktree never swaps in another file. The relative path is shown, and is the `file` the
comments name. When the file changes, a draft follows its text (`place`): same lines, else the nearest place its source
reappears, else the line holding its excerpt's first words; if the text is gone it stays at its old line marked **text
changed**.

The footer reads `N comments · + note · Discard · Send to #<id>` and shows while comments or a note remain. Send asks
`thread` for the file's thread, then calls Review's user-only `send` on it with `spec: "read:<absolute path>"` and every
comment as `{ file: <relative path>, side: "new", start, end, excerpt, text }`, sorted by line, plus the optional note.
Send stays disabled, with the reason, while there is no comment, the note or a comment is over Review's 4,000
characters, or there are more than 50 comments (`sendProblem`). When it lands, only drafts still exactly as sent are
cleared (`withoutSent`). The thread gets it as one `review.comments` input, which this extension renders as a card
(`card.solid.tsx`) for `read:` specs only; every other review keeps Review's card.

## Server (`server.ts`)

User-only actions (`refs.ts`), so codemode cannot call them:

- `read { path, conversation? }` → `{ path, absolute, root, text, mtime }`. `.md`/`.markdown` regular files up to 2 MB.
  A relative path resolves in the conversation's worktree, then the project root; an absolute one must be inside those
  roots. The worktree counts only while the workspaces index has it ready and its Git common dir is the project's
  (`paths.ts` `checkoutRoots`); an agent's cwd never does, since it can be any folder. Roots and target are compared
  after `realpath`, so `..`, `~` and symlinks pointing out are refused.
- `files { conversation? }` → `{ files: [{ path, mtime }], truncated }`: `git ls-files -co --exclude-standard`
  markdown in the checkout, newest first, at most 2,000.
- `thread { path, conversation }` → `{ id, from, path, started }`: the file's thread, the file resolved as `read` does
  from `conversation`. Two calls at once for one file start one branch.

## Privacy

The reader reads local files only and writes no file. Its one server write is the `reader.threads` document: each
file's absolute path, relative path and thread, never its text or comments. Drafts stay in this browser's local storage
until sent or discarded. Sent comments live only in the file's thread.
