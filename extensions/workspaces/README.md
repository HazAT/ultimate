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
Where checkouts live and how they are made can be configured in the project's settings, for repositories whose
tooling owns worktrees: company-internal monorepo tooling that must create and register each tree, a Git setup that
refuses worktrees outside one folder, or a team that keeps every tree in one place. All three keys are optional:

```json
{
  "isolates": {
    "worktree": {
      "path": "~/trees/{name}",
      "add": "./scripts/tree-add {path}",
      "remove": "./scripts/tree-remove {path}"
    }
  }
}
```

- `path` is where each checkout goes. `{name}` is `ult-<hash>-<conversationId>` (the lander's is `ult-lander-<hash>`),
  and a leading `~/` is expanded; the template must contain `{name}` and the result must be absolute. Without it, checkouts go under `<home>/worktrees` and
  `<home>/lander`. Checkouts outside `<home>/worktrees` are not counted in the workspace disk stats.
- `add` creates the checkout instead of `git worktree add`. It runs with `sh` in the source checkout, with `{name}`
  and `{path}` filled in as single shell words, and must leave a worktree of the source registered at `{path}`;
  Ultimate then runs `git checkout` there (the conversation's branch, or a detached tip for the lander). When it
  fails, or a crash interrupts it, Ultimate clears its half-made checkout and runs it again on the next attempt, so
  it must be safe to repeat.
- `remove` removes it instead of `git worktree remove`. Ultimate runs it only on a checkout without modified or
  untracked files, as Git would, and it must leave `{path}` unregistered.

The commands get five minutes each. A conversation started in a subfolder of its repository opens in the same
subfolder of its checkout.
Preparation runs `isolates.worktree.setup` with `ULTIMATE_SOURCE` set to the source checkout.
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
The service's `land(id)` fast-forwards a worker's source (its owner's checkout) to the worker's clean tip, for
`subagent land`; it refuses moved or diverged targets and never rebases or pushes. The only way to the project's
target branch is `workspace submit`.
`progress {ids}` (at most 100) reports `{id, uncommitted, unlanded}` for every ready worktree among `ids`, without
their subagents, for the sidebar's in-flight rows.
`pending {ids}` reports `{id, uncommitted, unlanded}` for checkouts with uncommitted changes or commits not on the
target, including transitively owned subagents, for the warning before concluding. The `workspaces` service exposes
`pending(ids, ctx)` and `release(ids, ctx)`; release removes every checkout that holds nothing only its folder
holds: no uncommitted changes and no commits on HEAD that neither its branch nor the target has (detached work).
Commits on its branch stay with the branch in the source, and the next input recreates the checkout on it. Release
deletes merged branches and returns checkouts kept for that work or `busy` reasons (running or queued input). Descendants release before ancestors; a kept descendant also keeps its
ancestors, reported with `descendant: <id>`. The removal transaction also checks current records sourced transitively
from the checkout, so a descendant resumed during the batch keeps its source ancestors. Nested recreation checks
its source parent's `ready` state and folder in the transaction that starts preparation; otherwise it readies the
parent and retries. Source queues are acquired ancestor-first for that decision and filesystem recovery.
Git writes are serialized per source and removal is never forced.
Release atomically checks run admission and marks the record `removed` before deleting the folder. Requests wait
on that same source queue before checking the record and recreating. Reconciliation and recreation finish
interrupted removals; newly found work at risk is kept and the checkout returns to `ready`. Refused removals report `reason` and
restore `ready` only if the folder remains a registered worktree. If removal succeeded before branch cleanup
failed, the record stays `removed` with the error so the next input can recreate it. Recovery through `ready()`
returns the kept record and retains the reason in workspace info.
On open, a background reconciliation releases concluded conversations' eligible checkouts, then `sweep` removes
checkouts in `<home>/worktrees` that no record knows (an earlier chapter made them; its records stayed with it) when
they are clean registered worktrees without detached work, deleting their merged branches; the others stay and are
named in a notice. Failures become notices.
`release(ids, ctx, signal?)` stops between checkouts when aborted. Closing aborts reconciliation and waits only
for the current checkout to finish, not the remaining batch.
`discard {id}` explicitly removes a clean checkout and keeps its branch until reuse (the `subagent` tool's
`discard` covers worktree children). All removed checkouts follow the same recreation rule above, preserving
unlanded branch history, including after explicit discard.
`stats` counts checkouts by state, ready ones by commits (landed on the target, ahead, none yet) and uncommitted
changes; `disk` measures the worktrees directory with `du`, and on btrfs also the real size with shared blocks counted
once (`btrfs filesystem du`). Measuring takes seconds, so one runs at a time and its result is reused for a minute.

## Lander

The lander is the only way to a project's target branch, and it is code: no model runs in it. Each submission and its
landing result appear in the submitting conversation as tool and outcome cards. The `@lander` conversation keeps the
full log in `ultimate.lander` entries and refuses every input.

`workspace submit` requires a non-empty `divergence` string: how the delivered result differs from the original
request (new agreements, different approach or library, changed scope), or "None" when it matches. It queues a
top-level main's clean tip in the root document's `queue` and returns its position and lander conversation at once;
the main keeps working. The submission saves `divergence` and `at`, the submitter's latest visible entry at submit
time, as a breadcrumb. One `workspaces.lander` task per source checkout (`landers`) processes that source's entries
in order.

The task runs in that source's lander conversation (`landerConversations`): ownerless, titled "@lander",
labelled `lander`, its cwd the lander checkout. The project's checkout has one from the moment the extension opens
(idempotently, the same record submit uses); another source gets its own on its first submit. It has no workspace and
is no main, so `workspace submit` refuses it. The task is its conversation's foreground work, so the Agents
tab shows it working while it lands. The sidebar pins every lander
conversation above the others, never concluded, with "idle · last <sha> <time>" or a pulsing "landing". It logs
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
2. Merges the submitted tip. A conflict aborts the merge and reports the conflicting paths to the submitter.
3. Runs `lander.checks` in order. Each check is stopped after 2 minutes without output or 10 minutes total, or at
   its own `timeout` (seconds, which also caps the no-output limit), killing its whole process group. Watchdog
   failures name the limit that fired, the failed test lines seen so far (vitest's `FAIL`/`×` lines, kept even when
   they scrolled out of the tail) and the output tail, and rerun like other check failures.
   An entry is a check or an array of checks, a group that runs concurrently; a check is a command string or
   `{ "command": "pnpm test", "timeout": 180 }`.
   A failing check
   reruns once: passing then is reported as flaky, failing again reports the output tail to the submitter once every
   command of its group settled. Each command keeps its own memo, steps and flaky note. A passed or flaky check records its last
   output line (ANSI stripped, at most 200 characters) as `summary`, shown muted after the command on its step row.
   A failed run's log entry keeps its output tail as `output` (not in `steps`), under a collapsed "Output" in the
   lander's log, so a check that then passed as flaky can still be diagnosed.
4. Fast-forwards the target branch in the source checkout (`merge --ff-only` when it is checked out). If the target
   moved meanwhile it starts again, at most three attempts.
5. With `lander.push`, pushes the target branch (never forced); a rejection integrates again once, then is reported.
6. Records `landed`, emitting `workspaces.landed` in the same commit, then reports (request id `lander:<submission>`
   for each write): the landed commit and commits, flaky checks, whether it pushed, "Needs restart." for `server/`
   or `shared/` changes to the running clone, and the lander conversation id for the full log.
   - A failure is a waking input to the submitter (a `workspaces.lander-report` entry): it fixes the cause in its
     workspace and submits again.
   - A landing is the end of the branch's work. The report is a note in the submitter, which starts no run. In one
     commit the submitter is concluded unless work is still under way: messages' `underway` (a run or queued input, a
     busy subagent, a reply-enabled message of its own still open, a pending notify or subagent report), through the
     `workspaces.branches` extension point messages provides. Then the conversation that started the branch
     (`starter`, from the same extension point) wakes with the same card, saying whether the branch is concluded or
     still has work under way (which then reports when it stops, as any branch does). Last, a concluded branch's
     checkout is released. A root or standing agent refuses concluding and stays open. Any later input resumes a
     concluded branch.

Settings (`.ultimate/settings.json`): `"lander": { "checks": ["pnpm check", [{ "command": "pnpm test", "timeout": 180 }, "pnpm test:e2e"]], "push": "origin" }`;
both are optional. They apply only once the project's setup is trusted: until then the lander refuses a submission
whose settings declare them, saying how to trust it, rather than landing unchecked. Anything that must follow every landing (a deploy, a notification) is an automation on the
`workspaces.landed` event.

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

Top-level mains use `workspace status` and `workspace submit` for their own checkout.
Landing reports commits and changed paths, with a restart hint for core changes to the running clone.
Landing never restarts Ultimate.
