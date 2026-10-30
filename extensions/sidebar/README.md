The Agent surface's sidebar and, on phones, the title bar's @ultimate button: talk to @ultimate, see each root's tree with what
is in flight and what landed, and switch, rename, compact, conclude and resume conversations. It is the UI that brings
the core together, so it sits at the top of the core tier: it reads conversations, workspaces, subagents, lineage and
messages, and shows what optional extensions provide through points (`conversations/ui.tsx`: a working phase, a plan task).
Its UI state keeps the keys it had as part of conversations (`ext.conversations.*`).
Rows under @ultimate's come from the `sidebar.under-ultimate` point (`ui.tsx`; side-chat fills it with open side
chats). The conversations the `sidebar.unlisted` point names (side-chat names every side chat) are left out of every
other list (`listed.ts`).

Every standing agent's row leads with its mark (conversations' `AgentMark`): a small tinted tile with a glyph — a brand
`U` for @ultimate (the title bar's wordmark), a green merge for the lander,
a bot for any other resident — with a presence dot in its corner (pulsing while it works or lands, amber while it
waits on you). Then a fixed display name (`Ultimate`, `Lander`, else the name capitalised) with
`@name` small and muted. The same mark sits in the title bar's button and before standing senders in chat bubbles.

The **project** heads the sidebar: its path from home (or `<project> #<worktree>`, the full path on hover) with a quiet
`History #id` on the right, and its root's **Memory** row under it, as one block. Clicking the path opens the root's
History, the project's read-only tally. A chevron before the path folds the block to that one row (folded by default,
kept in `ext.conversations.projectOpen`); folded, a quiet brain and memory count on the right of the path row opens
Memory instead.

The sidebar also stands beside lineage's Memory surface, so rows open conversations through `useShell` (`state.tsx`),
which brings the Agent surface back; beside Memory no conversation row is highlighted, the Memory row (or the folded
block's brain) is.

@ultimate has its own section below the project: its row shows `working`, `idle` or an amber
`N waiting on you` (reply-enabled messages to you still waiting on your answer or dismissal), and the age of its latest
message. The count is its own button: each click opens the next open question at its message (`messages:open`, as
the To-dos panel does), oldest first by id, then wraps to the oldest; it remembers only the last one it showed across
Agent and Memory in this page, so one answered or dismissed meanwhile is skipped. Clicking the rest of the row opens @ultimate on the Agent surface
through `subagents.standing {name: 'ultimate'}`, also before its conversation exists. Below it, an Agents group
lists the lander first, then the other ownerless top-level standing agents (label `agent`) by ID.
These rows are never concluded or hidden and show no summary or feature:
@lander shows its state (`landing` or `idle`), `queue N` while submissions wait,
and the age of its latest landing (what landed is its Landed section's first row); other agents show `working` or `idle` and the age. Their menu only
compacts the context; they are never renamed, cleared or concluded.

Beyond a phone the title bar's ULTIMATE wordmark (`titlebar.brand`) opens @ultimate too.
@ultimate's mark is amber while questions wait on you, and its line says how many; the To-dos tab lists them. On
phones, where the sidebar is hidden, the title bar's `@ultimate` button (`titlebar.left`) opens @ultimate from every
surface instead, with the same mark: its dot pulses while @ultimate works and is amber while questions wait.

Every section of the sidebar folds the same way (`Section`, `section.tsx`): a quiet mono heading with a chevron and
a count bubble, open by default, its fold state kept per section in `ext.conversations.closedSections`; the Scheduled
section of the `sidebar.top` slot draws the same heading. Top to bottom:

- **Project**: the chevron, the path, opening History, and the Memory row (or, folded, its brain count).
- **@ultimate**, then the **Agents** group: the lander first, with its **Landed · N** section right under its row,
  aligned with the other sections, then other standing agents.
- **Landed**: the latest landings of every root (lineage's `recent {id, types: ['landed'], limit: 20}`), newest
  first, all landings of one feature folded into one row: its feature tag (its title when it has none), `×N` when it
  landed more than once, the commits summed, and the age of the newest. Clicking the row opens the branch that landed
  it (the landing's `from`), else the root at its landing note. The commit count opens the range in Review when the
  group's landings follow each other on the target (else plain), with the DiffsHub compare as a small ↗ for a single
  landing (`CommitCount` from workspaces). The first five show; `+N more` unfolds the rest
  (`ext.conversations.landedAll`). Landings are read again whenever a root's token count changes, which every new
  entry does.
- **Memory** (inside the project block): one row per root (`MemoryRow`, `root.tsx`) with a brain mark, the brief's size (what every new branch
  starts from; the whole context's while it has no memories) and its memories counted by kind (`4 decisions · 5 facts
  · 3 lessons`). Clicking it opens lineage's **Memory** surface, grouped into decisions, facts and lessons (empty
  until @ultimate remembers something), and the row shows selected while it is open. The project path above it opens the root's tally, the browsable history (every
  branch, abstract and landing). The row has no menu; a root is never renamed, cleared or concluded here.
- The `sidebar.top` slot: background work that optional extensions contribute without the sidebar importing them,
  automations' **Scheduled**, up to five compact rows with `+N more`, and its own
  bottom rule. Each hides while it has nothing active.
- **In flight · N** (`InFlight`, `root.tsx`): every open branch of every tree, newest input first. A branch is open
  until it is concluded or it landed after its latest input (the lander's results, or a root landing note from it;
  a landed branch that gets new work is open again). Each shows its title, its feature tag, a state (`submitted` or
  `landing` while the lander has it, the working phase while it works, amber `awaiting @ultimate` while a
  reply-enabled message it sent @ultimate is open, red `failed`, else `idle`) and its age; clicking opens it, and its `…` menu is the same as an Earlier row's (Rename, Compact
  context, Conclude with the pending-work check). A branch
  with a worktree also shows its work so far on a quiet line below (workspaces' `progress`): `N commits` not yet on
  its target, opening `branch:<name>` in Review, and `+ N edits` (uncommitted changed paths), opening
  `uncommitted:<id>`. A fresh worktree, or a branch without one, shows nothing. All rows are read in one call, again
  only when an agent commits (`coding-tools.committed`), a worktree's state changes or a branch's run starts or ends;
  never on a timer. Its subagents follow, one line each at any depth (`SubagentLine`, `rows.tsx`): their mark, plan
  chip, role and `#id`, and their state word, with the latest activity or plan task on hover.

Landed branches and older conversations that are neither roots nor branches live in the collapsed "Earlier · N" group,
above "Concluded · N". There, branches nest under their source (`branchOf.conversationId`), with a hairline guide
and one indent per depth; siblings sort by latest input. Isolated rows carry a short `#<conversationId>` badge;
Workspace details in their menu opens Info's Workspace section. The shown row is highlighted, also while one of its
subagents is shown. Each row has its title (or `#id` for shared rows, `Untitled conversation` for isolated rows)
and the time of its latest message (`now`, `5m`, `3h`, `2d`,
then a date). Its leading mark pulses while it or any of its subagents works, and is solid when an answer arrived
since you last looked at it. Actual foreground tasks and live run boundaries determine Working, not the potentially
lagging title/timestamp list.
A solid purple dot means an unread reply, not ongoing work; only the pulsing dot means working.

Every row reads one state from messages’ `conversationState`, the same the System surface shows: working;
**waits on you** (only the primary agent, @ultimate: an open question to the user);
**awaiting @ultimate** (amber question mark, never on a subagent: an open reply-expected message the conversation sent
the primary agent); **done** (green check, subagents only: it answered, and its answer went to its parent);
**failed** (red cross: its latest input ended unanswered); else idle. Working includes queued input. Standing rows,
the In flight list (after the lander's submitted/landing) and the System lanes show the same state. Nothing
here is a model's opinion of a reply.

A conversation with genuinely owned children has an expandable Sub-agents group; a listed root shows none, since a
root runs no turns and its children predate its tally (they stay reachable by link and search). Rows show the recorded agent role/name,
its state (Working, Done, Failed or Idle, as above), and a brief what-it-did description of its latest reply.
During new work, an old activity is labeled Last reply.
A child linked to a plan task leads with the plan's `TaskChip` and shows the task title instead of its activity.
A row switches to its child, highlights selection and keeps the top-level summary visible. History forks are not
invented delegation edges. Expansion is persisted in `ext.conversations.expanded`; buttons support keyboard access.

@ultimate starts coordinator branches; there are no manual creation commands or isolation preferences. The sidebar
header names the project's path (`<project> #<worktree>` in a branch checkout), the full path on hover; Info's first
section lists the checkouts.
Conclude releases clean, fully landed checkouts, including owned subagent checkouts. Uncommitted files,
unlanded commits, and busy checkouts are kept.
Info's Workspace section shows checkouts read-only.

On hover or focus, a row's `…` menu offers Rename (inline; also on double-click; Enter or leaving the field saves,
Escape cancels, and after either key focus returns to the row), Compact context (keeps the gist and frees context;
disabled while the conversation works), and Conclude. Before concluding, the UI calls workspaces `pending {ids}`.
When a conversation or its subagents have uncommitted files or unlanded commits, a confirmation dialog names the
work and explains that its checkout is kept until the work lands or is discarded. Otherwise it concludes at once.
Concluded rows and their branches/subagents sit in a collapsed "Concluded · N" group at the bottom.
Resume brings them back. Any input that starts a run in a concluded conversation (typed input, a message or
reply, a subagent report, an automation's message) resumes it and its concluded ancestors in the commit that places
the input, through the patched `GenerationTask.beforeInput` hook. Notes and other writes start no run and resume nothing.
Concluding the shown subtree shows another live conversation when one exists.

Commands, under Conversations: `conversations.summary-model` ("Summary model…", see [Summary model](#summary-model)). The UI state keeps concluded
ids in `ext.conversations.concluded` and, in `ext.conversations.seen`, the latest answer time seen per top-level
conversation; a conversation not recorded there counts as seen.
