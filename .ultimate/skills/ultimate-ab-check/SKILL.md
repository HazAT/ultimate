---
name: ultimate-ab-check
description: 'Run an ultimate-eval A/B of an Ultimate commit against its parent before a core change lands, and read the results back. Use before submitting a change to timers, routing, the lander or other session plumbing, or when asked for an A/B.'
---

# A/B a core change before it lands

The ultimate-eval project runs a scripted session (`recipe-v2`) on a commit and scores it. Two runs on the commit
under test and two on its parent rule out crashes and obvious breakage. They are a sample, not proof.

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
  `--scenario recipe-reminder`: it creates a reminder automation, checks it fires and reaches the user, and scores
  unanswered and duplicate board messages (about 3 min and $0.50 a run).
Watch most closely: <paths the change touches>. I'll read runs/ myself; no reply needed when you start.`
await ultimate.tell({ project: 'ultimate-eval', text, reply: false })
await tools.automation({
  action: 'create',
  name: 'Check A/B for #<branch>',
  schedule: 'in 25m',
  subscribers: ['@ultimate'],
})
```

`reply: false` because a "started" answer would use up the reply. The check-back automation is the guarantee: a run
takes about 6 minutes, four in a row about 25. Then end the turn.

## 3. Read the results

When the check-back wakes you, list the newest runs and read each `result.json`:

```sh
cd ~/Projects/ultimate-eval/runs && ls -d 2026* | tail -6
for d in <run ids>; do echo "$d $(jq -c '{pass,status,min:.minutes,stuck:.failure.stuck,usd:.scorecard.usage.totalCostUsd,wd:.scorecard.watchdog,real:.scorecard.toolErrorDetail.real,landed:.allLanded,startup:.startupSec}' $d/result.json 2>/dev/null || echo running)"; done
```

A run folder without `result.json` is still running only while its `live.json` names a live `pid`
(`kill -0 $(jq .pid $d/live.json)`): then set another check-back. Without one it was abandoned: report it as
incomplete, never wait on it. `pnpm eval report` in
`~/Projects/ultimate-eval` prints the passes/N, median minutes and cost matrix per commit. For a failure, `failure`
says where it stood and `transcripts/` holds every conversation. Delete the check-back automation once it is read.

## 4. Report

Per side: passes/N, minutes, cost, stuck, watchdog failures and retries, real tool errors, all landed, startup
seconds, and the run ids. Then the limits, always:

- At N=2 it rules out crashes and obvious breakage, not small differences.
- Name the paths the change touches that the scenario never reaches (an error branch, compaction, an automation
  fire, a chapter change). Those stay covered only by the regression test for the change.
