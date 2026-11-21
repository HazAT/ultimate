## Front-end baseline for the Solid 2 + ui-sdk migration

The migration's purpose is a front end that is more robust, faster, simpler and smaller than the React one. Each step
reports its delta on the numbers below against this baseline, and after the UI kit and the first batch of extensions a
decision gate compares the migrated extensions with their React originals on lines, renders and bundle size.

The migration is done (C5, `f3e6078`): the core and every built-in extension are Solid, and React remains only in the
lazily loaded compat layer for outside `web.tsx` facets ([React facets on a Solid core](extensions/react-compat.md)).
Result against pure React, both trees measured on 2026-11-21 from one paused snapshot on a quiet machine (load 1–3),
in two interleaved sessions (each value the median of three runs; the range spans the sessions):

|                                  | `a0638de4` (pure React) |          `f3e6078` (C5) |
| -------------------------------- | ----------------------: | ----------------------: |
| Switch, cold                     |              565–633 ms |              443–598 ms |
| Switch, warm                     |              171–196 ms |              210–219 ms |
| Streamed event: task, mutations  |               4.9 ms, 1 |               4.1 ms, 1 |
| React components per stream op   |                      92 |                       0 |
| Entry assets / all JS, gzip      |          432 / 2 823 KB |          410 / 3 003 KB |
| Front-end lines (Solid / compat) |          49 954 (0 / 0) | 56 750 (48 557 / 2 525) |

Cold switches overlapped between the trees; warm switches were slower at C5 in both sessions. The `pure React` entry in `docs/frontend-progress.json` was measured under heavy load
on an older snapshot (748.5 / 273.5 ms), so the progress page's switch percentages overstate the gain. The series of
every step is in that file; the sections below say how each number is measured.

Measured on main at `1c5d056` (step 0.3 landed; three Solid files: the keep-warm chip and two kit controls), 2026-11-19,
on one machine. Speed numbers drift with machine load: compare within one session, medians of repeated runs.

The `a0638de4 (pure React)` column is the last main before any migration code (the parent of step 0.1); its
`134703f` neighbour is main re-measured in the same session (2026-11-19), so those two columns share identical
conditions and the final Solid result compares against them. Both ran today's scripts (`frontend-weight.ts` copied
into the `a0638de4` checkout, the `measure-switch` scripts from `134703f`) in detached worktrees, each server started
like `instance start` (`server/main.ts`, its own home, every agent on `openai-codex/gpt-6.2-sol`); speed numbers are
the median of three runs, the range after it is the spread of those runs (the noise).

### The series: `docs/frontend-progress.json`

Every migration step adds one entry with its lines and bundle, which come from files and do not depend on machine load:

```bash
git worktree add --detach ~/fw/<sha> <sha> && (cd ~/fw/<sha> && pnpm install --frozen-lockfile --prefer-offline)
node scripts/frontend-progress.ts ~/fw/<sha> --label 0.8 --summary "<what the step did, one line>"
```

Timing (`switch`, `stream`, `previews`) is measured on main only, on a quiet machine, after C2 (transcript), C4
(shell) and C5 (React removed): add `--only switch,stream,previews --snapshot ~/fw/snap/state.sqlite`, the snapshot
copied with `node .ultimate/skills/measure-switch/copy-paused.ts ~/.ultimate/projects/<home>/state.sqlite ~/fw/snap`.
Other entries keep `null` there, which the progress page shows as not measured.

Run it from the newest checkout: it measures the given tree with today's scripts, starts each server on a scratch home
outside the real home, with a scripted model, `claude-code` disabled and no provider credentials, refuses a snapshot
copy that is not paused or a tree with uncommitted changes, and replaces only that commit's entry: entries are never
dropped, so the file keeps every step. Per entry:

- `lines`, `perExtension`, `bundleGzipKB` and `entryGzipKB` come from `frontend-weight.ts`.
- `switch` is the `settledMs` median of three `switch.ts --rounds 3` runs on a copy of the paused snapshot (`cold` is
  round 0, `warm` rounds 1–2). Compare entries measured from one snapshot: a new snapshot has other conversations.
  The backfill ran on 2026-11-20 under heavy machine load (load average 15–20 from parallel branches), so a run's
  cold median spread up to 30% (585–790 ms at `a0638de4`); read the switch series as flat within that noise.
- `stream` replaces the real model turn above: the scripted model streams one fixed 40-chunk reply, so every tree gets
  the same `ops` events (23–25), and three runs repeat to the unit (`median` 92, `p95` 127). Per `ops` event it records:
  - `median`, `p95`, `max`: React components rendered. Solid work is invisible to it, so it falls as the transcript
    moves to Solid whether or not the page does less; it stays beside the others until C5 removes React.
  - `mutations`, `mutationsP95` (from C0): DOM mutation records inside `[data-ui="transcript"]`, counted with a
    MutationObserver, whichever framework made them, within the event's window: from its dispatch until its next task.
    A deferred write (a later timer, an animation frame) counts for no event. This is the comparable number across the
    core switch. At C0 a streamed delta changes about one text node (median 1, p95 2) while React renders 92
    components for it: the gap is render work that produces no DOM change. A rise means a host now rewrites rows it
    used to keep.
  - `taskMs`, `taskP95Ms` (from C0): time from the event until the next task: the handler, render and commit of either
    framework, plus any work already queued ahead of it, so it is latency rather than time spent on the event alone.
    The median is the steady cost; the p95 is the slow events a reader feels as jank. One run's p95 can jump with
    machine load (27 ms in one of three C0 runs, 6–7 ms in the other two), so read the median of runs.
- `previews` (`scripts/preview-bench.ts`) runs three status-line tasks (keep-warm, pause, reading the setup issues)
  three times each from a fresh page, once with CSS selectors and screenshots and once with `ui` steps (`null` before
  `ui` steps existed at `1c5d056`). `tokens` estimates what the agent reads back: text at 4 bytes a token, a
  1440×900 screenshot at width × height / 750. `agent` is a worker on `openai-codex/gpt-6.2-sol` given the keep-warm task
  in plain words, three runs, counted from its stored entries; measured by hand and only at some commits.
- `previewUsage` (`node scripts/preview-usage.ts ~/.ultimate/projects/<home>`) counts browser calls, `ui`/click/eval
  steps and screenshots per week over every chapter of the project's history, read-only.

### Code and bundle: `node scripts/frontend-weight.ts`

Non-blank lines of `web/src/**/*.{ts,tsx,css}` and every `extensions/*/**/*.tsx`, tests excluded; the production
bundle as `server/web-build.ts` builds it for this checkout, with no user or project extensions. Entry assets
(`entryAssetsGzip`) counts only the JS and CSS the HTML links; the facets the page loads at startup come on top, so it
is not the whole first load.

| Measure                        | `a0638de4` (pure React) | `1c5d056` (baseline) | `134703f` |
| ------------------------------ | ----------------------: | -------------------: | --------: |
| Front-end lines                |                  49 954 |               50 526 |    50 624 |
| of which `web/src`             |                  10 320 |               10 793 |    10 915 |
| of which `extensions/**/*.tsx` |                  39 634 |               39 733 |    39 709 |
| of which Solid (`.solid.tsx`)  |                       0 |                  126 |       186 |
| Files                          |                     262 |                  269 |       271 |
| Bundle JS, all chunks          |               13 364 KB |            13 658 KB | 13 655 KB |
| Bundle JS, all chunks, gzip    |                2 823 KB |             2 923 KB |  2 922 KB |
| CSS, gzip                      |                   24 KB |                24 KB |     24 KB |
| Entry assets (JS + CSS), gzip  |                  432 KB |               449 KB |    450 KB |

### Conversation switching: the `measure-switch` skill

A paused copy of the project's first chapter (1.5 GB), conversations 30726, 97078, 171689 and 32858 (6 200, 6 143,
4 665 and 2 337 entries), start at 1, `--rounds 3`; the baseline from two runs, the other columns from three runs on
two copies of one snapshot, one per tree (warm is the median over both warm rounds of every run):

| Median      | `a0638de4` cold | `a0638de4` warm | Baseline cold | Baseline warm | `134703f` cold | `134703f` warm |
| ----------- | --------------: | --------------: | ------------: | ------------: | -------------: | -------------: |
| `settledMs` |   699 (696–716) |   258 (205–281) |           781 |       245–271 |  746 (716–786) |  246 (229–265) |
| `longMs`    |   290 (285–307) |      58 (55–61) |       289–297 |         58–59 |  321 (294–346) |     59 (57–68) |
| `eventKb`   |           1 724 |             511 |         1 724 |           511 |          1 724 |            511 |

### A streaming turn: `renders.ts --send`

A fresh preview, one real turn (`"Reply with three short paragraphs about Solid signals, no tools."`); the baseline
from two runs, the other columns from three turns in conversation 1 of one fresh home per tree:

| Per `ops` event (the streamed transcript) |         `a0638de4` (pure React) |                        Baseline |                   `134703f` |
| ----------------------------------------- | ------------------------------: | ------------------------------: | --------------------------: |
| React components rendered, median         |                     96 (91–116) |                           90–92 |                128 (90–609) |
| React components rendered, max            |                   898 (735–941) |                         820–980 |             980 (828–1 041) |
| Main-thread task, median / p95            |                  5.4 ms / 26 ms |              5.2–5.9 ms / 35 ms |            6.0 ms / 24.3 ms |
| `ops` events per turn                     |                            9–19 |                                 |                         5–7 |
| Top owners                                | `App`, `Transcript`, `Composer` | `App`, `Transcript`, `Composer` | `App`, `Transcript`, `Rail` |

The streaming numbers are the noisiest here: a turn's `ops` count follows the model's chunking, and with 5–7 events a
single heavy one moves the median (the 609 run). Read them as "no change from pure React" until a step changes `App`.
The switch numbers repeat within about 10% cold and 20% warm. To reproduce a column: `git worktree add --detach
<dir> <sha>`, copy `scripts/frontend-weight.ts` in if missing, then follow the `measure-switch` skill with its
scripts from the newest checkout.

`App` re-rendering on every streamed op is the shell reading a whole object; Solid's per-path updates are meant to
remove exactly that, so this is the number the core switch (phase 3) should move most.
