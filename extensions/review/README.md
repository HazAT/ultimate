The Review surface: the project's local Git diffs, its files on the left and their changes on the right, rendered with `@pierre/diffs` in Ultimate's fonts and colours.

What it shows is a **spec**:

- `uncommitted`: the work tree against `HEAD`, untracked files included (ignored ones not). `uncommitted:<id>` is the
  same in conversation `id`'s worktree (the project checkout once it has none); its default recipient is `id`.
- `<sha>` (or any ref naming a commit): that commit against its first parent; a root commit against the empty tree.
- `<a>...<b>`: what `b` changed since it forked from `a`, as a landing's `<base>...<sha>`.
- `branch:<name>`: the branch against the target branch it lands on (its worktree's target, else the project checkout's branch).

The header picks the spec (recent choices from `ranges`, or any spec typed in), sums `+N −M · K files`, switches split and
unified, and links the range to DiffsHub when `origin` is on GitHub. On a phone the file list is a dropdown and the
diff is unified. The diff stack is virtualized; the viewer loads with the surface, not with the app.

**Comments.** Click a line number (shift-click or drag for a range, on either side) or the gutter `+` to open an
inline composer; the range highlights as it grows, with a bar down its line numbers. **Add to review** keeps it as a
draft under its lines, which can be edited or deleted. Drafts are durable UI state (`drafts.ts`) keyed by spec and by
the conversation whose worktree the diff came from (`draftsKey`; a spec too long for a key is named by its SHA-256), so
a reload and other tabs keep them. A draft holds only its lines and text; its excerpt (at most 40 lines and 8 KB) is
read from the diff on screen when the review is sent. One spec's drafts may take 96 KB of the 256 KiB UI state: past
that the composer stays open and says it is too long to keep, and a write the server refuses shows a notice. While any are pending, a footer reads
`N comments pending · + note · Discard · Send review (N)` and the header has a **to** picker (standing agents and
recent conversations). Its default comes from `recipient`. Sending posts one `review.comments` input into that
conversation; the drafts it sent clear (ones added meanwhile stay), and the footer links to it (`Sent to #id`), or
says why it was not sent. The recipient's transcript shows a review card on the user's side (`card.tsx`), each
comment's `file:line` chip opening Review there. The model reads `reviewText` (`comments.ts`):
`Review of \`<spec>\` (N comments)`, the note, then per comment `` `path:start-end`(old|new) ``, a fenced excerpt
(language from the extension) and the text. Paths and specs are inline code delimited by a backtick run longer than any
in them, with control characters such as a newline written as`\n`.

Links: `/?review=<spec>` opens Review at that spec, and the address carries `?review=` while Review is on screen;
`&file=<path>&line=<n>` (and `&side=old`) scrolls to that line and marks it.
`openReview(spec, at?)` from `link.tsx` does the same from code. Review provides the `workspaces.review` point, so the
landing card, the Activity feed and a root's landed list open a landing's commit count here (DiffsHub stays as a small
↗ beside it), and a branch row's menu has **Review changes**. Without review those stay plain DiffsHub links.

Actions (`refs.ts`):

- `diff { spec, conversation? }` → `{ spec, kind, title, base?, head?, patch, files, truncated? }`. Runs in
  `conversation`'s worktree while it has one, else the project checkout. Every ref is checked with
  `git rev-parse --verify` as a commit, and any part starting with `-` is refused. A file's patch over 400 KB is listed
  as `tooLarge` without hunks; past 8 MB in all, later files are too and the diff is `truncated` (caps count bytes).
  An untracked symlink shows as a new file whose one line is its target (one with a path git would quote or a
  multi-line target is listed as `symlink`, without hunks); a file that became a symlink or stopped
  being one is listed as `typeChanged`, without hunks.
- `ranges` → recent specs: uncommitted, open `ultimate/*` branches with their conversation, the last ten landings
  (`workspaces.landed` events) and the last fifteen commits; branches and landings carry their `conversation`.
- `recipient { spec }` → `{ conversation }`: a `branch:` spec's worktree owner, a landing range's submitter (by its
  tip in `workspaces.landed`), a commit's `Ultimate-Conversation` trailer, else the primary agent.
- `send { conversation, spec, comments, note? }` (user only) → `{ conversation }`. At most 50 comments, each text up
  to 4,000 characters and excerpt up to 40 lines and 8 KB, to an existing conversation; it steers a busy one.
