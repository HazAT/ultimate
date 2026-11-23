---
name: ultimate-ab-check
description: 'Run an ultimate-eval A/B of an Ultimate commit against its parent before a core change lands, and read the results back. Use before submitting a change that alters what a scenario exercises (turn flow, delivery and routing, the lander, restart and core swap, prompts and agent definitions) and that no regression test proves, or when asked for an A/B.'
---

# A/B a core change before it lands

The ultimate-eval project runs a scripted session (`recipe-v2`) on a commit and scores it. Two runs on the commit
under test and two on its parent rule out crashes and obvious breakage. They are a sample, not proof.

Each A/B costs about 25 minutes and $5–15. Run one only when both hold:

- The change alters behaviour a scenario exercises: turn flow, delivery and routing, the lander, restart and core
  swap, or prompts and agent definitions, which no test covers.
- No regression test that fails without the change proves it. A rare race the scenario cannot hit rests on its
  regression test; an A/B adds nothing there.

Skip it for a change inside one extension that its tests cover, a rebase without logic changes and UI work. An epic
of several slices gets one A/B on its final head, not one per slice.

## 1. Pick the two commits

- **Under test:** the committed head of the branch, as a full sha (`git rev-parse <sha>`). It must be reachable from
  `~/Projects/ultimate` (`git cat-file -t <sha>` there): worktree commits are.
- **Baseline:** its parent on main. Earlier runs of the same baseline count only when they ran on the same
  scenario sha (the run's `scenario@<sha>` in `pnpm eval report`); otherwise run both sides fresh. Name the run ids.
- A head that moves after the A/B (review fixes) keeps the A/B when the new commits do not touch what it exercised;
  say so in the report.

## 2. Ask ultimate-eval (only @ultimate)

A coordinator sends @ultimate the two shas, a few lines on what changed, and what to watch; @ultimate relays it.
@ultimate, in one codemode call:

```js
const text = `Request from Ultimate's @ultimate (A/B before a core change lands). A/B on ~/Projects/ultimate:
- Under test: <full sha> (<one line on the change>).
- Baseline: <full sha> (main).
- recipe-v2, default setup, --repeat 2 each. For a change to automations or message routing, add (or use instead)
  --scenario recipe-reminder: it creates a reminder automation, checks it fires and reaches the user, and scores
  unanswered and duplicate board messages (about 3 min and $0.50 a run).
Reply with the run ids and their results when they are done.`
await tools.tell({ project: 'ultimate-eval', text })
```

Then end the turn. The reply is the wait: ultimate-eval's "started" answer arrives as a note, the sidebar shows
`waits on ultimate-eval · run 2/4`, and the result wakes you once (four runs take about 25 minutes). If ultimate-eval
cannot answer (not running, its work dropped), a failed reply wakes you with the cause.

## 3. Read the results

Check the reply against the run files: list the newest runs and read each `result.json`:

```sh
cd ~/Projects/ultimate-eval/runs && ls -d 2026* | tail -6
for d in <run ids>; do echo "$d $(jq -c '{pass,status,min:.minutes,stuck:.failure.stuck,usd:.scorecard.usage.totalCostUsd,wd:.scorecard.watchdog,real:.scorecard.toolErrorDetail.real,landed:.allLanded,startup:.startupSec}' $d/result.json 2>/dev/null || echo running)"; done
```

A run folder without `result.json` is still running only while its `live.json` names a live `pid`
(`kill -0 $(jq .pid $d/live.json)`). Without one it was abandoned: report it as incomplete, never wait on it.
`pnpm eval report` in `~/Projects/ultimate-eval` prints the passes/N, median minutes and cost matrix per commit. For a
failure, `failure` says where it stood and `transcripts/` holds every conversation.

## 4. Report

Per side: passes/N, minutes, cost, stuck, watchdog failures and retries, real tool errors, all landed, startup
seconds, and the run ids. Then the limits, always:

- At N=2 it rules out crashes and obvious breakage, not small differences.
- Name the paths the change touches that the scenario never reaches (an error branch, compaction, an automation
  fire, a chapter change). Those stay covered only by the regression test for the change.
