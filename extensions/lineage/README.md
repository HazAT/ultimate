A project is a forest of conversation trees. Each root keeps a non-agent tally of one line of work: one intent line per branch, each conversation's latest abstract, notes and landings. Branches do the work with that shared context.

The UI calls a root's tally its **context** ("what every new branch starts from"); "tally" stays the internal name in
documents, tools and model-facing text.

## Concepts

- **Roots.** `lineage.roots` on conversation 1 (`{ roots }`, initially `[1]`; `useRoots()` in `roots.tsx`) lists them.
  A conversation's root is found up through owners (subagents) and fork sources (branches). A project has one root;
  independent work goes into branches. The first branch of an empty root makes it a tally from that entry
  (`lineage.tally.since`). Tallies refuse inputs and run no turns.
- **Branches.** A branch forks its source (by default its latest entry) as an ownerless conversation, optionally in its
  own worktree, and gets its prompt and images as its first input. The tree root gets a one-line node,
  `#<branch> started by <caller> from #<source>/<at>: <intent>`, where the intent is the starter's `title` (one line, at
  most 60 characters) or the prompt's first 80 characters; that is also the branch's title until its summary names it.
  The prompt itself stays in the branch, so later branches never inherit it. Agents start branches with the messages
  extension's `branch` tool; there is no action.
- **Tally.** `lineage.tally` on a root: `{ abstracts, tokens, briefTokens?, since? }`, each conversation's open
  abstract, the estimated tokens of the root's model context and of its memory brief, and where it became a tally. The
  sidebar's Memory row shows what a new branch starts from: "Memory · … tokens" (the brief), or "Context · … tokens"
  (the whole tally) while the root has no memories.
- **Abstracts.** The conversations summarizer publishes each branch's abstract after every exchange (`abstract` below).
  An abstract is liquid until its conversation lands, like an uncommitted working tree: the first is model-visible and
  becomes the anchor; later ones edit the anchor's text in place, so the tally never reorders. The transcript shows each
  anchor with its newest text and `#N/at` breadcrumb.
- **Landings.** Each `workspaces.landed` event leaves a note in the submitter's tree root (`source: 'lander'`, with
  `sha`, `base`, `target`, `commits`, `paths`, `divergence`, `at`), its text naming the `#N/at` breadcrumb and
  `Diverged: …` (also "None"). A landing freezes the submitter's open abstract into the note as "State at landing"; the
  next abstract opens a new anchor. Concluding the branch and waking its starter is the lander's
  (`extensions/workspaces/README.md`).
- **Notes.** `note { to: id | 'root', text }` writes a `lineage.note` without waking the target; its model reads
  `Note from #N: …` with its next input, and future branches inherit notes in the tally. Note cards use the `--note`
  theme token.
- **Notify.** `notify { id, wake? }` waits until the target and its subagents are idle, then delivers `#id finished ·
  <title>` with its last own answer (at most 1500 characters): as a follow-up (`lineage.finished`), or with
  `wake: false` as a note. Calling again for the same id replaces the pending request; an answer already delivered
  waits for the target's next one.
- **Catch-up on resume.** When an idle conversation gets input, a "Meanwhile in #R's tree" note goes in before it: new
  or updated abstracts, prompts without one, landings with divergence and breadcrumbs, notes, and any tally compaction,
  excluding its own activity. Within about 6000 tokens the newest stay in full and older ones collapse to one line.
  The note also lists up to 30 new target commits, overlaps first, with conversation trailers and an isolate's behind
  count. Nothing new means no note; mid-run inputs and tallies get none. `lineage.seen` `{ main?, at?, tally? }` keeps
  the baseline.
- **Prompt.** Branches are told their origin, intent, tree root and inherited tally (or, with a brief, the memory index
  and where the full tally is), and how to follow `#conversation/entry` breadcrumbs with `ultimate.entries(id)` and
  `ultimate.search()`. Other top-level conversations get their own id and lookup guidance; roots and subagents get
  nothing.
- **Compaction.** `compact` on a listed tally root runs the harness's compaction: older tally content is summarized,
  recent entries stay verbatim, and `instructions` guide the summary. It keeps the idea, principles, standing decisions
  and each conversation's id, prompt, outcome, divergence, commits and breadcrumbs. To correct a decision, change the
  root's memory instead. Branch compaction focuses on intent and progress; subagents keep Pi's default.

## Project memory

`lineage.memory` on a root (`MemoryDoc` in `refs.ts`) holds up to 150 memories (`MEMORY_LIMIT`) by slug
(`^[a-z0-9][a-z0-9-]{0,47}$`): `{ kind: 'decision' | 'fact' | 'lesson', line, body, source?, updated }`, `line` one line
of at most 120 characters, `body` at most 2000, `source` a `#<conversation>/<entry>` breadcrumb.

- **Writing.** Every write goes through `applyMemoryOps` (`memory.ts`) as an all-or-nothing batch of
  `{op:'add', slug, kind, line, body, source?}`, `{op:'update', slug, …}` and `{op:'delete', slug}`. The deferred
  `remember {root?, ops}` tool is the standing `ultimate` agent's only (a branch could find it with `tool_search`); it
  defaults to the caller's tree root, else the project's only root. User-only `forget {root, slug}` deletes one;
  `LineageApi.remember` serves other extensions.
- **Reading.** `memory {read?, root?}`, offered to every agent, returns the index, one
  `slug [kind] — line (updated YYYY-MM-DD)` per memory, or with `read` one memory's body and source.
- **Brief.** A branch from a root with memories starts from a brief instead of the tally: `<project_memory root="#R">`
  with the index, the root's last 10 landings and where to read the full tally. The inherited tally stays in storage;
  `lineage.branch` records `brief: true`.
- **Landings.** Each landing in a tree (not from the root itself) asks the summary model once for memory ops in the
  root, with the landing note, the submitter's abstract and every memory. It defaults to no ops, prefers updates to
  near-duplicates, deletes or rewrites what the landing replaced, and merges at the cap. Without a summary model nothing
  happens; a refused answer is asked once more, then left as a notice. The landing itself never fails on it.

The **Memory** surface (`MEMORY_SURFACE` in `ui.tsx`, opened from the sidebar's Memory row) shows every root's memory
grouped into Decisions, Facts and Lessons, newest first, with a filter, the count and brief size, and the `MemoryHeader`
point (dream's Dream button). A row expands to its body and source; its trash icon calls `forget`. `useOpenMemory(slug?)`
and `MemoryChip` open it on one memory.

### Memory review

A root's first memories are written by @ultimate during onboarding with `remember`. Later, a review branch @ultimate
starts reads the memory, the project context, old conversations, the code and `git log`, and fact-checks each memory:
still true, outdated (with evidence) or contradicted by a later decision. It proposes new ones with their source and
date. It never writes: it returns add, update and delete ops, each with a one-line reason, as a `Decisions:` block.
@ultimate weighs in, the review branch asks the user, and @ultimate applies the chosen ops with one `remember` batch.

## Go back

The message action **Go back to here**, on any stored message of a non-root conversation, opens a confirm dialog fed
by `rewindPreview {conversation, at}`: the steps set aside, the files that path touched with their line counts, the
commits since, and the conversations that built on it (subagents and branches it started, conversations it messaged).
User-only `rewind {conversation, at, summarize?}` then sets everything after `at` aside from the model's context with
one `lineage.rewound` note; with `summarize` the summary model summarizes the set-aside path into it. The conversation
keeps its id, worktree, files and commits, and nothing runs until the next input. It refuses roots, busy conversations,
running compactions, points before the newest compaction or reset, and a context that changed meanwhile. It emits
`lineage.rewound {conversation, at, entry, dependents}` and marks each dependent, which keeps running. The transcript
folds what was set aside into **N steps set aside · show**.

## Actions

- `info` → `{ roots }`; with `{ id }` also its `root` and `branch`.
- `recent {id, limit?, types?}` → `RootEvent[]` (`types.ts`): a root's newest events, newest first (default 3, at most
  20): landings `{ sha, base?, commits, feature?, title?, from?, compare? }`, other notes, new branches, compactions
  and the genesis, each with `entry` and `at`. With a GitHub `origin`, `compare` is the DiffsHub URL of
  `<base>...<sha>`. The sidebar's Landed section shows them.
- `compact {id, instructions?}` → `{ taskId }` compacts a listed tally root (the palette's Compact on a root).
- `unlist {id}` → `{ roots }` removes a root that never became a tally and is not the last; its tree's conversations
  leave every tree. Concluding only hides a conversation; unlisting stops a mistaken root being offered to `branch`.
- `rewindPreview`, `rewind`, `forget` (above); `openEditor` and `talkToUltimate` (the History page).

## Service and events

`host.need(LineageApi)` (`api.ts`, with the `Roots`, `Branch` and `MemoryDoc` documents):

- `branch({ from, prompt, at?, title?, images?, isolated?, model?, thinkingLevel?, deliver?, by?, receipt? }, ctx)` →
  `{ id }`. `receipt: { taskId, callId }` makes it replay-safe. `deliver: false` leaves the first input to the caller
  (messages sends a reply-enabled message). `by` attributes the tally's branch node to that caller.
- `rootOf(id, ctx)`: the tree root, or undefined outside any tree.
- `leaveNote(to, text, source?)` writes without waking; `'root'` needs `source.from`.
- `remember(root, ops, ctx)`: one memory batch; `memoryBrief(id, ctx)` and `memoriesOf(id, ctx)` read the brief and
  the memories of a conversation's tree root, else the project's only root.

Lineage provides conversations' `conversations.trees` point: `rootOf`, `branchOf` (`{ root, intent? }` for top-level
non-root conversations in a tree) and `abstract(tx, id, { text, at, title?, feature? })`, which the summarizer calls in
its transaction, before the first table write. The forking commit
emits `lineage.branched` `{ id, from, at, intent, title? }` (`Branched` in `api.ts`); plan reads `lineage.branch`
(`Branch`, `{ from, at, intent }`) to empty an inherited plan.

## UI

The user talks to @ultimate in its own conversation (the first sidebar row; on phones, the top-bar button); it reads
tallies and starts coordinator branches. A branch's header and System lanes label it `branch · coordinator`. There is
no manual creation page.

A root is the project's read-only **History** page, opened from the sidebar's project path. Its composer is replaced by
one banner, "You're reading the project's history", with **Open in Zed** (`openEditor`: `zeditor` or `zed` on the
machine Ultimate runs on; hidden on touch devices), a GitHub link when `origin` is there, and **Back to @ultimate**
(`talkToUltimate`, like mod+0). Memory lives in the sidebar and the Memory surface; the palette's Compact runs
`compact`. A root's transcript shows no summary or assessment lines; a genesis reset shows a collapsible **Context
starts here** card, and old notes and inputs still render quietly.
