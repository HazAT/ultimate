# Workspaces

An isolated conversation gets its own Git checkout. Coordinator branches started by @ultimate are isolated by
default. Subagents can select `isolate: "worktree"` for the same setup. Uncommitted source changes are not included.

Isolation needs a Git repository with a checked-out branch and a first commit. Until a project has them, `isolation`
returns `{ reason }`, an isolated start fails with that reason, and the project has no lander.
@ultimate handles Git setup through onboarding before starting isolated work. `isolation` also reports whether the
folder is `empty`; once the project can be isolated, it stands the lander if there is none, so a first commit brings it
without a restart. `setupGit` makes an empty folder isolatable (`git init` where needed, then an empty first commit) and
refuses a folder with files, whose first commit is a judgement for an agent; onboarding's Git card offers both.

Each conversation has one record in the root `ultimate.workspaces` document.
Its path is `<home>/worktrees/<conversationId>`; its branch includes the home hash and conversation ID.
Preparation fills the new worktree per `isolates.worktree.clone`: `auto` (default) clones the source checkout
copy-on-write (APFS `clonefile` on macOS, `cp --reflink=always` on Linux), ignored files such as `node_modules`
included and submodules left out, then resets tracked files to the branch and removes untracked ones; when cloning
fails it checks out plainly and reports the backend and reason in a notice. Repository identity failures (a path
that is a symlink, the source itself, or a checkout whose admin dir points back elsewhere) always abort before
destructive operations. Absolute symlinks pointing inside the source are removed after copying
(tracked links are restored by reset), so ignored links cannot lead back into the source. Copied nested worktrees
whose gitdirs point into the source's common Git directory are removed too. `apfs` and `reflink` insist on their
backend; `git` always checks out plainly. The lander's checkout always checks out plainly. `du` counts cloned blocks
in full, so the disk row overstates on APFS. Cloned ignored files keep any absolute paths written into them: a
Python virtualenv's scripts still run the source's interpreter and install into the source's environment, so setup
should recreate such environments. Registering with `--no-checkout` skips the `post-checkout` hook.
It then runs `isolates.worktree.setup` with `ULTIMATE_SOURCE` set to the source checkout.
Setup commands must be safe to repeat after interruption.
What a project's setup should do (dependencies, `.env`, a copy-on-write SQLite clone, a dev port per worktree, skipping
the database in the lander's checkout, and when to ask about Postgres) is the "Worktree setup" step of the
`integrate-ultimate` skill; setup health warns while an isolatable project with a package manifest has none.
The first model request waits for preparation. Before every tool call, the workspace must be ready with a
present, registered checkout. Otherwise the tool is blocked with the reason; the model can still reply and
explain why it cannot use the checkout.
A removed workspace is recreated at the same path on the next model request. An existing branch with unlanded
commits is checked out unchanged, with its tip as the new base; a merged or missing branch starts at the current
target tip. Nested isolates prepare their source ancestor checkouts first.
The existing `workspace_workflow` prompt section starts and waits for the same durable preparation task used
on creation; setup commands run again before the model can use tools.
Failed setup keeps its output tail and never force-removes dirty output. The conversation's next tool call retries it (checkout and setup again), so fixing the cause, such as a PATH without `pnpm`, takes effect in the same conversation; until it succeeds every tool call is blocked with the setup's error.

Info's Workspace section (`Workspaces` in `ui.tsx`) shows the lander queue, the shown conversation's checkout and
statistics over every checkout, read-only: landing goes through agents. Concluding a conversation can release its clean, landed checkout.
`isolation` says why the project cannot be isolated, if it cannot; `info {id}` reads the record and current tips; `create {cwd?, title?}` returns a new conversation ID.
`github` returns `https://github.com/<owner>/<repo>` of the project's `origin`, or null off GitHub; landing cards and
the root row link commit ranges with it.
`workspace land` fast-forwards the saved source branch to the clean, verified workspace tip.
Unrelated dirty files in the source checkout do not block; `git merge --ff-only` refuses only real overlap.
If the target changed or diverged, update the workspace onto it and verify again; landing never rebases or pushes.
`progress {ids}` (at most 100) reports `{id, uncommitted, unlanded}` for every ready worktree among `ids`, without
their subagents, for the sidebar's in-flight rows.
`pending {ids}` reports `{id, uncommitted, unlanded}` for checkouts with work at risk, including transitively
owned subagents. The `workspaces` service exposes `pending(ids, ctx)` and `release(ids, ctx)`; release removes
only clean, fully landed checkouts, deletes merged branches, and returns checkouts kept for pending work or
`busy` reasons (running or queued input). Descendants release before ancestors; a kept descendant also keeps its
ancestors, reported with `descendant: <id>`. The removal transaction also checks current records sourced transitively
from the checkout, so a descendant resumed during the batch keeps its source ancestors. Nested recreation checks
its source parent's `ready` state and folder in the transaction that starts preparation; otherwise it readies the
parent and retries. Source queues are acquired ancestor-first for that decision and filesystem recovery.
Git writes are serialized per source. Removal refuses a missing checkout and a HEAD that no branch, tag or remote
reaches. It forces only past submodules, which Git refuses even in a clean checkout, and only when the checkout is
clean, no submodule has uncommitted changes, and every submodule repository's commits are on a remote-tracking ref
after a fetch that prunes deleted branches; an unreachable remote keeps the checkout. Ignored files are deleted, as
Git does.
Release atomically checks run admission and marks the record `removed` before deleting the folder. Requests wait
on that same source queue before checking the record and recreating. Reconciliation and recreation finish
interrupted removals; newly found pending work is kept and the checkout returns to `ready`. Unlanded counts include
commits reachable from either the branch or HEAD, including detached work. Refused removals report `reason` and
restore `ready` only if the folder remains a registered worktree. If removal succeeded before branch cleanup
failed, the record stays `removed` with the error so the next input can recreate it. Recovery through `ready()`
returns the kept record and retains the reason in workspace info.
On open, a background reconciliation releases concluded conversations' eligible checkouts; failures become notices.
`release(ids, ctx, signal?)` stops between checkouts when aborted. Closing aborts reconciliation and waits only
for the current checkout to finish, not the remaining batch.
`discard {id}` explicitly removes a clean checkout and keeps its branch until reuse (the `subagent` tool's
`discard` covers worktree children). All removed checkouts follow the same recreation rule above, preserving
unlanded branch history, including after explicit discard.
`stats` counts checkouts by state, ready ones by commits (landed on the target, ahead, none yet) and uncommitted
changes; `disk` measures the worktrees directory with `du`, and on btrfs also the real size with shared blocks counted
once (`btrfs filesystem du`). Measuring takes seconds, so one runs at a time and its result is reused for a minute.

## Lander

Each submission and its landing result appear in the submitting conversation as tool and outcome cards.
The `@lander` conversation keeps the full log in `ultimate.lander` entries; these do not depend on Messages.

`workspace submit` requires a non-empty `divergence` string: how the delivered result differs from the original
request (new agreements, different approach or library, changed scope), or "None" when it matches. It queues a
top-level main's clean tip in the root document's `queue` and returns its position and lander conversation at once;
the main keeps working. The submission saves `divergence` and `at`, the submitter's latest visible entry at submit
time, as a breadcrumb; synchronous `workspace land` is unchanged. One `workspaces.lander` task per
source checkout (`landers`) processes that source's entries in order; merging, checks, fast-forward and push are
code, and a model runs only on a failure or when someone writes to the lander.

The task runs in that source's lander conversation (`landerConversations`): ownerless, titled "@lander",
labelled `lander`, its cwd the lander checkout. The project's checkout has one from the moment the extension opens
(idempotently, the same record submit uses); another source gets its own on its first submit. It has no workspace and
is no main, so `workspace submit` and `land` refuse it. The task is its conversation's foreground work, so the Agents
tab shows it working while it lands. The sidebar pins every lander
conversation above the others, never concluded, with "idle · last <sha> <time>", a pulsing "landing", or "fixing" /
"diagnosing" while its model works on a failure. It logs
every submission as `ultimate.lander` entries, which carry no model message, so no model run in that conversation
sees them: `queued`, `started`, each step, each check with `passed`, `failed` or `flaky`, and the outcome (`landed`
with `sha`, `commits`, `paths`, `flaky`, `pushed`, or `failed` with `reason` and the `output` tail). Each line is
committed with the task state change or doc update it describes; a check result is logged right after the check
runs, so a crash before its memo logs the rerun too. The same commits record each step as `{ step, at, check? }` in
the queue entry's `steps`; when the submission ends, its steps, outcome, tip and target move into the root document's
`results` (the latest 50).

The submitter follows the lander in its own transcript, from that document. The `workspace submit` card shows
`submit · <tip> → <target>` and a status chip (`queued #2`, the current step with a spinner, `Landed <sha> · pushed`,
`Not landed`); below it an "N steps" toggle, open while queued or landing and closed once finished, lists the step
rows and ends in a quiet "full log in #<lander>" link. The lander's report message renders as an outcome card with
a success, warning (landed, push failed) or error accent and the same collapsed steps. Nobody has to open the lander
conversation; it keeps the full log, grouped by submission, and shows in the Agents tab.
The commit that records a landed outcome (also when only its push failed) emits the durable event
`workspaces.landed` (`SubmissionLanded` in `api.ts`): submission, submitter and its `at`, `sha`, `base`, `target`,
lander, divergence, the submit-time title, summary and feature, the first ten commits with `commitCount`, the first
eight paths and `pushed`. Failures emit nothing. Each check run, a rerun included, emits `workspaces.check`
(`CheckRan`): submission, command, `passed`, `failed`, `flaky` or `timeout` (a watchdog stopped it) and its `ms`, in the
commit that logs its result. Lineage reacts to it with a landing note in the submitter's tree
root, exactly once, unless the submitter is that root or has none; the lander itself calls no lineage service. Its
data includes `divergence` and `at` alongside `from`, `sha`, `target`,
`commits` and `paths`; model text cites `#<from>/<at>` and always includes `Diverged: …`, even for "None". The
submit-time summary stays in the data and on the card but not in the model text: it is often stale, and the tally's
abstract of the submitter tells its story. In a tally, the note freezes that abstract: it carries it as `abstract`
with a `State at landing` block in its text, and the card shows it collapsed (see the lineage README).
The shared landing card in the root and submitter shows a quiet Diverged line and the breadcrumb.
Failed submissions leave no root note; notes never wake the root.

What lands is named once, at submit: the queue entry keeps the submitter's `subject` (title, summary and feature)
from the `conversations` service's `subject(id)`, so a later retitle does not rename it. The result, the lander log's
first lines and outcome, and the root note carry that snapshot. `landing.tsx` renders it the same everywhere: the
`LandingCard` (feature tag, title, summary, then the outcome) is the lander log's outcome, the submitter's report and
the root's landing note; its one-line `Subject` heads each submission in the lander log and the submit card, and the
lander's sidebar row shows the feature it lands or landed last.

1. Resets its own detached checkout, `<home>/lander/<hash of source>`, to the target branch tip. `isolates.worktree.setup`
   runs once when the checkout is created. With `lander.push`, it fetches the remote branch and merges it when it is ahead.
2. Merges the submitted tip. A conflict aborts the merge and reports the conflicting paths.
3. Runs `lander.checks` in order. Each check is stopped after 2 minutes without output or 10 minutes total, or at
   its own `timeout` (seconds, which also caps the no-output limit), killing its whole process group. Watchdog
   failures name the limit that fired, the failed test lines seen so far (vitest's `FAIL`/`×` lines, kept even when
   they scrolled out of the tail) and the output tail, and enter the same rerun/fix flow as other check failures.
   An entry is a check or an array of checks, a group that runs concurrently; a check is a command string or
   `{ "command": "pnpm test", "timeout": 180 }`.
   A failing check
   reruns once: passing then is reported as flaky, failing again reports the output tail once every command of its
   group settled. Each command keeps its own memo, steps and flaky note. A passed or flaky check records its last
   output line (ANSI stripped, at most 200 characters) as `summary`, shown muted after the command on its step row.
   A failed run's log entry keeps its output tail as `output` (not in `steps`), under a collapsed "Output" in the
   lander's log, so a check that then passed as flaky can still be diagnosed.
4. Fast-forwards the target branch in the source checkout (`merge --ff-only` when it is checked out). If the target
   moved meanwhile it starts again, at most three attempts.
5. With `lander.push`, pushes the target branch (never forced); a rejection integrates again once, then is reported.
6. Records `landed`, emitting `workspaces.landed` in the same commit, and reports to the submitter as a follow-up input: the landed commit and commits, flaky checks,
   whether it pushed, "Needs restart." for `server/` or `shared/` changes to the running clone, and the lander
   conversation id for the full log (changed paths and output tails live there).

7. With `lander.deploy`, if any landed changed path starts with a configured prefix, sends one one-way
   message (through the `workspaces.handoff` extension point, which messages provides) from the lander to the named
   standing agent. It asks the agent to deploy the landed SHA and report to the submitter, with the commit subjects,
   matching paths and push status. This is a handoff, not a deployment: the lander does not wait.
   `deploy → @<agent>` appears in the submit card's steps, full log and report, which is why the handoff stays in
   the lander's report phase rather than reacting to `workspaces.landed`. Messages admission and a sender-scoped
   receipt (`lander-deploy:<submission>`) commit atomically, so replaying after a crash cannot send twice, even when
   a new lander task resumes the report. An unknown or non-resident agent, or a failed handoff, records a warning
   step and notice; the landing stays landed. Invalid deploy settings give a notice and disable only the hook. No
   setting or no matching paths means no deploy step.

Settings (`.ultimate/settings.json`): `"lander": { "checks": ["pnpm check", [{ "command": "pnpm test", "timeout": 180 }, "pnpm test:e2e"]], "push": "origin" }`;
both are optional. Optional `"deploy": { "agent": "cloudflare", "paths": ["src/", "wrangler.json"] }` inside
`lander` enables the deploy handoff. `paths` is a non-empty list of non-empty path prefixes (not globs), and `agent`
must name a resident agent. The messages extension must be enabled.

### The lander's model

The lander conversation is configured from the effective agent definition named `lander` (built-in
`agents/lander.md`, overridable in `~/.ultimate/agents/` or the project's `.ultimate/agents/`, editable in the Agents
tab): its model (else the main conversation's), thinking, tools (minus `workspace`) and instructions. Opening applies
it to every lander conversation, and so does any change to a definition folder, so the next message or failure uses
the definition as it is now. Its composer works like any conversation's: ask it what landed or why #12 failed. A
`lander_state` prompt section, only in lander conversations, lists that source's queue (submission id, #N, tip, state, step) and
its latest results (outcome, sha, push, reason).

`onFailure: diagnose | fix` (default `diagnose`) decides what happens on a merge conflict or a check that failed
twice. The checkout stays as it failed (a merge in progress, or the merged commit), the queue entry's `agent` and step
read `fixing` or `diagnosing`, and the task submits a prompt with the reason, output and mode to the lander
conversation (request `lander-agent:<submission>:<attempt>`, placed as an `ultimate.lander-ask` entry) and waits for
it to settle; a resume waits for the same run.

- diagnose: the checkout is reset and the submission fails with the model's answer as `diagnosis`, shown on the
  outcome cards and appended to the report as "Diagnosis by lander".
- fix: the checkout must be clean, without a merge in progress, with new commits on top of the failed merge. Then the
  next attempt starts from that commit and runs every check again; landing reports "Fixed by lander" with the
  model's commits (`fixed`). Anything else, or a fix that still fails, is reported as not landed. A submission gets
  one fix.

Without a `lander` definition, failures are reported without a model.
Each attempt starts from a reset checkout, and the integrated commit is memoized after the checks, so a crash resumes
safely. Failed submissions are dropped from the queue after their report.

The fast-forward records `landed: { sha, base, commits, paths, flaky }` on the queue entry in the same commit as the
workspace's `landed`. A lander task that ends after that and before its report, for example one faulted because a
reload of this extension changed the Workspaces document, loses its memos but not that record: whichever task picks
the entry next skips merging and checks, pushes exactly `landed.sha` when the target still contains it, and reports
the original landing. "Nothing new to land" means the tip was already in the target before this submission.

The extension restarts a lander for every source whose queue holds submissions while its task is missing or ended:
when the harness opens, on each reload of the extension, and at once when a task of the previous code faults. A fault
of the current code's own task waits for the next submit or open, so a deterministic fault does not loop.

Top-level mains use `workspace status`, `workspace submit` and `workspace land` for their own checkout.
Landing reports commits and changed paths, with a restart hint for core changes to the running clone.
Conclude releases only idle checkouts with no uncommitted or unlanded work.
Landing never removes a checkout or restarts Ultimate.
