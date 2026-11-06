A project is a forest of conversation trees. Each root keeps a non-agent tally of one line of work: one intent line per branch, each conversation's latest abstract, notes and landings. Branches do the work with that shared context.

The UI calls a root's tally its **context** ("what every new branch starts from"); "tally" stays the internal name of the
document, tools and model-facing text, where agents and stored entries already use it.

- **Branch** (`LineageApi.branch`
  `{ from, at?, prompt, title?, images?, isolated?, model?, thinkingLevel?, deliver?, by?, receipt? }` → `{ id }`; there
  is no action: agents start branches with the messages extension's `branch` tool, whose reply-enabled first message
  returns the branch's answer). It forks the source at `at` (default: its latest entry) as an
  ownerless conversation in the project root, optionally isolated in its own worktree. It inherits the source context
  (or, from a root with memories, starts at a memory brief: see Project memory), then the durable `lineage.prompt` task submits the prompt and images as its first
  input. Doc `lineage.branch` holds `{ from, at, intent }`; `inputAt` is when the branch was asked for, not inherited
  activity. The fork happens before the tree root receives a model-visible `lineage.branched` node
  `{ branch, at, intent, images?, from? }`, so the branch does not inherit its own node. The node's model text is one
  line, `#<branch> started by <caller> from #<source>/<at>: <intent>`, where `intent` is the `title` the starter gave
  (one line, at most 60 characters), else the prompt's first 80 characters on one line; either is also the branch's
  title until its summary names it. The prompt and its images stay in the branch's own first input, so later branches
  never inherit them. Nodes written before this carried the whole prompt;
  they are not rewritten and shrink at the next compaction. `from` is present
  when the source is not the root; that source also gets a display-only marker. The forking commit emits the durable
  event `lineage.branched` `{ id, from, at, intent, title? }` (`Branched` in `api.ts`); lineage's own `named` reactor
  (for it and `lineage.rooted`) has conversations mark that title as generated (`generatedTitle`), so the summary model
  still replaces a given title. Lineage provides
  conversations' `conversations.trees` point (`rootOf`, `branchOf`, `abstract`) that summaries use. Plan reads `Branch` (also in `api.ts`) and empties the inherited plan in the commit
  that places the branch's first input.
- **Roots**: doc `lineage.roots` on conversation 1 (`{ roots }`, initially `[1]`) lists the roots. Clients stream it
  (`useRoots()` in `roots.tsx`). Root lookup walks owners and fork sources to a listed root; conversations outside
  those trees have none. A project has one root; independent work goes into its branches.
  The first branch of an empty root writes an empty `pi.reset` there to fork from, in the same commit making the root a
  tally from that entry (`lineage.tally.since`); its history then builds up from branches and landings, while branches
  start from its memory. Tallies refuse inputs and run no turns.
  `info` returns `{ roots }`, and with `{ id }` also its `root` and `branch` when present.
  `unlist` `{ id }` → `{ roots }` removes a root that never became a tally from the list: it refuses non-roots, the
  last root and tallies. The root and its branches then belong to no tree. Concluding only hides a conversation;
  unlisting is how a mistaken or abandoned root stops being offered to `branch`.
  `recent` `{ id, limit?, types? }` → `RootEvent[]` (`types.ts`) lists a listed root's newest events, newest first
  (default 3, at most 20; only the given `types` when set): landings `{ sha, base?, commits, feature?, title?, from?,
  compare? }` (`commits` counts the note's listed commits plus `more`), other notes `{ from?, text }`, new branches
  `{ branch, intent }`, compactions, and the genesis (`started`), each with its `entry` and `at`. With a GitHub
  `origin`, a landing's `compare` is `https://diffshub.com/<owner>/<repo>/compare/<base>...<sha>` (DiffsHub's view of the GitHub range); a note from before
  landings recorded `base` uses the landing before it, which is where the lander's serial queue left the target.
  Catch-up notes and abstracts are left out. The sidebar's Landed section, under the lander, shows the landings.
  Workspaces' `github` action gives the root page's landing cards the same range.
  `compact` `{ id, instructions? }` → `{ taskId }` compacts a root's tally (see Compaction), for the palette's Compact
  command on a root.
- **Tally**: conversation-scoped doc `lineage.tally` (latest history) holds
  `{ abstracts: Record<string, { anchor, at, text, title?, feature? }>, tokens: number, briefTokens?: number, since?: number }`:
  each conversation's open abstract, estimated model-visible context tokens, estimated tokens of the memory brief
  (absent without memories), and the entry where the root became a tally. Forks start with an empty doc,
  not the source's bookkeeping. Both counts are recounted after commits that append root entries (including resets and
  compaction) or change its memory. The sidebar's Memory row shows what a new branch starts from: "Memory · …
  tokens", the brief, or "Context · … tokens", the whole tally, while the root has no memories.
  `lineage.abstract` entries hold `{ conversation, at, text, title?, feature?, anchor? }`, with `at` pointing to the
  answer summarized. An abstract is liquid until its conversation lands, like an uncommitted working tree: the first
  one is model-visible and becomes the anchor; later ones are carriers without model messages (`anchor` set) whose
  `edits` replace the anchor's text in place, so the tally never reorders. An anchor a compaction or genesis replaced
  takes no edits; the next abstract opens a new one. While a compaction of the tally runs, an update opens a new anchor
  too and omits the old one, since the compaction may replace it after the update. Storage stays append-only. The
  transcript shows each anchor as a card with its newest carrier's text and `#N/at` breadcrumb; carriers render
  nothing, and a frozen anchor hides.
- **Notes**: `note` `{ to: id | 'root', text }` writes a `lineage.note` without waking the target; `'root'` resolves
  the caller's tree root. Its model reads `Note from #N: …` with its next input, or a future branch inherits it from
  the tally. Note cards use the mellow yellow `--note` theme token. `ConversationRef` names conversations by feature,
  else title, then `#N`; model text keeps bare ids. Other extensions call `leaveNote(host, to, text, source?)`;
  `'root'` needs `source.from` and errors if it has no root. Successful landings leave a note in the submitter's root
  (unless it is that root or has none): the reactor `lineage/landing-notes` handles each `workspaces.landed` event
  once, placing the note in a tally inside its own transaction, or, for a root that is no tally yet, creating a
  `lineage.landing-note` task in it that delivers the note as a write (request id `lander-root:<submission>`).
  Concluding the landed branch and waking its starter is the lander's report (`extensions/workspaces/README.md`). The
  note has `source: 'lander'`, `sha`, `base`, `target`, `commits`, `paths`, `divergence` and
  `at`. Text includes the submitter's `#N/at` breadcrumb and `Diverged: …`, including "None"; the landing card shows
  divergence too (up to 10 commits and 8 changed paths). A landing is the commit of a liquid abstract: in a tally, a
  lander note for a submitter with an open abstract carries it as `abstract` `{ at, text, title?, feature? }` and a
  `State at landing (abstract as of #N/at):` block, omits the anchor in the same write and closes it, so the frozen
  state lives only in the landing; the card shows it as a collapsed "State at landing". The next abstract opens a new
  anchor after the landing. Every lander note in a tally is placed in one transaction that checks for an open
  abstract and freezes it if there is one, with request-id deduplication, so no abstract can open between the check
  and the landing.
- **Project memory** (`memory.ts`): doc `lineage.memory` on a root (`MemoryDoc` in `refs.ts`; forks start empty)
  holds `{ memories: Record<slug, { kind: 'decision' | 'fact' | 'lesson', line, body, source?, updated }> }`: slugs
  match `^[a-z0-9][a-z0-9-]{0,47}$`, `line` is one line of at most 120 characters, `body` at most 2000, `source` a
  `#<conversation>/<entry>` breadcrumb, at most 150 memories (`MEMORY_LIMIT`). Every write goes through
  `applyMemoryOps(tx, root, ops)` with ops `{op:'add', slug, kind, line, body, source?}`,
  `{op:'update', slug, kind?, line?, body?, source?}` and `{op:'delete', slug}`: it validates the whole batch against
  the memory as the batch leaves it first (fields, add of an existing slug, update or delete of a missing one, the cap
  after the batch, a listed root) and throws before writing anything, so a batch is all or nothing; it returns a short
  summary. Deferred tool `remember {root?, ops}` (named in @ultimate's definition) writes one batch, defaulting to the
  caller's tree root, or outside a tree (@ultimate) to the project's only root; with none or several it names them
  and asks for one. It refuses any caller but the standing `ultimate` agent, since a branch can find a deferred tool
  with `tool_search`. Tool `memory {read?, root?}`, offered to every agent, returns the index, one
  `slug [kind] — line (updated YYYY-MM-DD)` per memory, or with `read` one memory's body and source. User-only
  `forget {root, slug}` (`ForgetAction`) deletes one through the same path, as does `LineageApi.remember` for other
  extensions. The **Memory** surface (`MEMORY_SURFACE` in `ui.tsx`, the sidebar beside a centred reading column;
  the sidebar's Memory row opens it) shows every root's memory grouped into Decisions, Facts and Lessons, newest
  first, under the `MemoryHeader` point (dream's Dream button), the count and brief size, and a filter over slug, line
  and body: slug, line (two lines folded) and age per row; a row expands to its Markdown body and source chip, and a
  trash icon (always visible on touch) calls `forget`. `useOpenMemory(slug?)` and `MemoryChip` (recall and remember
  chips) open the surface on a memory, unfolded and scrolled into view (`MEMORY_FOCUS`); `ui.tsx` also re-exports
  `MemoryDoc` for the sidebar's counts.
  **Brief**: a branch forked from a root that has memories does not start from the tally. Its fork gets a
  `pi.reset` (`head: 'self'`, `data.lineage.brief: {tally}`, the root tip it covers) right after the fork point,
  before its prompt, whose model text is `<project_memory root="#R">` with the index, the root's last 10 landings (`<sha7> <feature: title> (#conv)`) and
  where to read the full tally; the branch's model context starts there, the inherited tally stays in storage.
  `lineage.branch` records `brief: true`, the prompt section says so, and `lineage.seen.tally` starts at the root's tip
  at the fork, so catch-up reports only what came after. A root without memories branches as before, and a fork of
  another branch keeps that branch's context: its inherited tally position is the brief's `tally` when the fork point
  lies after the brief reset.
  **Landings**: reactor `lineage/memorize` turns each `workspaces.landed` event of a tree (not from the root itself)
  into one background `lineage.memorize` task in the root; a `lineage.memorize-receipt` family member per submission
  on the root, never evicted, keeps it to one per landing. The task resolves the summary model
  (`summaryModelStatus()`) and memoizes it; without one it completes without asking. It memoizes its input (the
  landing note's text, the submitter's abstract, frozen into the landing or still open, and every memory in full) and
  the summary model's answer, then asks for JSON `{"ops": [...]}`, with an output budget of `MEMORIZE_TOKENS` (16384, reasoning included) instead
  of a summary's 2048, under rules that default to no ops, prefer updating
  to near-duplicates, delete or rewrite memories a landing removes or replaces, and merge at the cap, with one example
  answer. The parser takes the one object with an `ops` array (extra keys ignored) or a bare array of ops, also inside
  one code fence or between prose; two fences, no batch or invalid JSON refuse it, the last with the JSON error; adds and
  updates take the landing's `#<submitter>/<at>` as source. Since nobody corrects a landing's batch, `normalizeMemoryOp`
  first collapses each `line` to one line and cuts a long `line` or `body` at a word boundary with `…`, and kebab-cases
  a slug outside the pattern; the `remember` tool stays strict. The ops commit with the task's completion, so a resumed task applies them once. An unparsable answer, one cut off at the budget, or a refused batch writes nothing and is asked once
  more with the refused answer and the reason appended (a memo of its own); when that is refused too, it leaves a notice. The landing itself never fails on it.
- **Go back** (`rewind.ts`, `rewind.tsx`): the message action **Go back to here** on any stored message of a non-root
  conversation (standing agents included) opens a confirm dialog fed by `rewindPreview {conversation, at}`: steps set
  aside; the files the set-aside path touched (files of its commits, a merge's against its first parent, and paths
  the `edit` and `write` calls in every stored entry after the point named, resolved as those tools resolve them) with
  their `git diff --numstat` against the checkout's tip at the entry, untracked, "changed" (no HEAD to count against,
  or no difference), or "changed, outside the checkout" (never passed to Git), so uncommitted work from before the
  entry stays out;
  commits since; and the conversations that built on the path (subagents and branches it started, conversations it
  messaged per `board.sent` events, read by kind since messages depends on lineage). User-only `rewind {conversation, at, summarize?}` runs task
  `lineage.rewind` in the conversation: it appends one `lineage.rewound` entry whose `edits` omit every entry after
  `at` that still contributes (and restore entries up to `at` an earlier go-back changed), and whose user-role message
  is the note. The conversation keeps its id, worktree, files and commits; nothing runs until the next input, and the
  prefix up to `at` contributes byte-identically, so a warm provider cache can hit. With `summarize`, the summary model
  summarizes the set-aside path into the note (memoized; without an answer the note lists the files). The task reads
  the context first and memoizes the facts with that revision (its newest entry); a retry or the final commit refuses
  with "changed meanwhile" once any entry that the model sees lands after it. It refuses roots, busy conversations (a
  run or queued input), running compactions (both at admission and in the final commit), and points before the newest
  head marker (a compaction or reset). A suffix of only tool results can be set aside too. It
  emits `lineage.rewound {conversation, at, entry, dependents}` and writes a display-only
  `lineage.rewound-dependent` marker in each dependent, which keeps running. The transcript folds what a go-back set
  aside (`data.setAside`) into **N steps set aside · show**.
- **Notify**: `notify` `{ id, wake? }` starts `lineage.notify` in the caller. It waits until the target and its
  subagents are idle, then delivers `#id finished · <title>` with its last own answer (≤1500 chars), not an inherited
  source answer. `wake` (default true) submits a follow-up placed as `lineage.finished`; `wake: false` leaves a note
  with `source: 'finished'`. Request id
  `lineage:notify:<target>:<task>` deduplicates delivery; calling again for the same id aborts the pending task.
  The caller's `lineage.notified` `{ answers: { [target]: entryId } }` records the answer entry each delivery carried;
  when the idle target's newest own answer is that one, the task watches commits for the target's next entry and
  waits for its next idle instead of repeating it.
- **Catch-up on resume**: `lineage.seen` `{ main?, at?, tally? }` tracks the target commit and last accounted-for root
  entry. Branch creation seeds `tally` to the position its fork inherits: the newest root entry in its history up to
  the fork point, or the `data.tally` of the newest catch-up note there, which every catch-up records. Without either
  it starts from `lineage.tally.since`. Prompts of the conversations it was forked from are left out: it reads them as
  their inputs. On an idle resume, the transactional `GenerationTask.beforeInput` hook builds
  "Meanwhile in #R's tree": open abstracts whose anchor or a carrier is new, as they read now (preferred over
  prompts), prompts without an abstract, landings with divergence and breadcrumbs (a conversation without an open
  abstract shows its newest landing's frozen state), notes, and any new tally distillation. It excludes the caller's own
  activity. Within about 6000 tokens it keeps the newest material in full, collapsing older conversations to one-line
  status with a pointer to `ultimate.entries(root)`; no model call runs in input placement.
  The same note then lists up to 30 new target commits, overlaps first (workspace diff against merge-base, or the
  conversation's own edit/write calls in a shared checkout), with conversation trailers and an isolate's behind count.
  In a repository subdirectory, commit counts, history and overlaps follow the project directory, including in isolated
  workspaces; repository-root projects still include empty commits. History reads are capped metadata queries, with a
  separate overlap search so older overlaps keep priority without reading every commit's filenames. Scoped history
  follows both sides of merges and includes merges that bring project changes in; the workspace behind count stays
  repository-wide.
  No new tally material or commits means no note; mid-run inputs do not trigger catch-up. The local Pi Durable patch
  commits the `lineage.note` (`source: 'main'`), seen baselines and input atomically, with the note before the input
  in transcript and context. Tallies take no inputs and get no resume catch-up.
- **Prompt**: roots and subagents get no lineage section. Branches are told their origin and intent, tree root and
  inherited tally contents (or, with a brief, the memory index and where the full tally is), and how to follow `#conversation/entry` breadcrumbs with `ultimate.entries(id)` and
  `ultimate.search()`. Other top-level conversations get their own id and lookup guidance. No list of roots changes
  the prompt cache.
- **Compaction**: action `compact` `{ id, instructions? }` → `{ taskId }` starts the harness's existing compaction
  on a listed tally root, refusing non-roots, non-tallies and roots already compacting.
  Compaction summarizes older tally content and keeps recent entries verbatim; a short tally may stay unchanged.
  Instructions guide that summary without deleting history. To correct a recent or standing decision, @ultimate
  changes the root's memory with `remember`. Its own model keeps the idea,
  principles, standing decisions and each conversation's id, prompt, outcome, divergence, commits and breadcrumbs,
  merging superseded detail. Every top-level conversation's summary source is its model view with edits applied, so
  abstracts read as last updated and frozen ones stay out. Branch compaction focuses on intent and progress; subagents keep Pi's default.

## Memory review

A root's first memories are written by @ultimate during onboarding with `remember`. Later, its memory is checked and
cleaned up by a review branch that @ultimate starts. The review coordinator reads the index and bodies (`memory`), the project context and old
conversations (codemode `ultimate.entries` and `ultimate.search`, with `{project}` for another project), the code and
`git log`. It fact-checks each memory: still true, outdated (with evidence), or contradicted by a later decision; and
proposes new memories, each with its source `#conversation/entry` and date. It never writes: it returns add, update
and delete ops, each with a one-line reason, as a `Decisions:` block. @ultimate weighs in, the review branch asks the user, and once their answer
reaches @ultimate it applies the chosen ops with one `remember` batch.

Other extensions use `host.want(LineageApi)` (`api.ts`, with the `Roots` document): `rootOf(id, ctx)` resolves tree membership,
`leaveNote(to, text, source?)` writes without waking, and `branchOf(id, ctx)` returns `{ root, intent? }` for top-level
non-root conversations in a tree (undefined for roots, owned conversations and outsiders).
`abstract(tx, id, { text, at, title?, feature? })` opens or updates `id`'s abstract in that root in the caller's
transaction, before its first table write because it reads conversation records; it is a no-op wherever `branchOf`
is undefined. The conversations summarizer uses this to publish an abstract after each completed exchange.
`branch({ from, prompt, at?, isolated?, model?, thinkingLevel?, deliver?, by?, receipt? }, ctx)` starts a normal lineage branch.
An optional `receipt: { taskId, callId }` records the branch id atomically with the fork in the originating task's
`lineage.branch-receipts` document. Repeating that task and call returns the same branch; Pi retires the receipt when
the task completes. The method returns `{ id }`. With `deliver: false`, no `lineage.prompt` task is created: the caller
must deliver its first input (messages uses a reply-enabled message). `by: conversationId` attributes the tally's branch node to that caller,
including its standing-agent name when available.

The user talks to @ultimate in its own conversation, opened by the first sidebar row (on phones, the top-bar @ultimate button); it picks a root by reading tallies and starts coordinator branches.
A branch is the conversation; the coordinator is the agent that runs it, so the header and System lanes label it `branch · coordinator`.
There is no manual creation page or message-hover branch action. Coordinator branches keep their composers for steering.

A root is the project's read-only History page. Through the SDK's `composer` renderer, every listed root replaces
its composer with one banner, "You're reading the project's history", with **Open in Zed** (lineage `openEditor`, user-only: the
project folder in `zeditor` or `zed` on the machine Ultimate runs on; hidden on touch devices) and a small GitHub link
when `origin` is there, and **Back to @ultimate** (`talkToUltimate`, like mod+0). The sidebar's project
path opens it. There is no text input, memory list or compact button on the page: memory lives in the sidebar's Memory
row and the Memory surface, and the palette's Compact on a root runs lineage `compact` while its composer-focus command
is hidden. A new project starts in @ultimate's conversation instead, from onboarding's Start here card.
@ultimate maintains standing decisions in memory with `remember` and the memory review. A root's transcript shows no
summary or assessment lines.

Old stored notes and survey inputs still render quietly, without creation controls. Old brief resets still render;
a genesis reset shows a collapsible **Context starts here** card.
