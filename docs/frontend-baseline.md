## Front-end baseline for the Solid 2 + ui-sdk migration

The migration's purpose is a front end that is more robust, faster, simpler and smaller than the React one. Each step
reports its delta on the numbers below against this baseline, and after the UI kit and the first batch of extensions a
decision gate compares the migrated extensions with their React originals on lines, renders and bundle size.

Measured on main at `1c5d056` (step 0.3 landed; three Solid files: the keep-warm chip and two kit controls), 2026-11-19,
on one machine. Speed numbers drift with machine load: compare within one session, medians of repeated runs.

The `a0638de4 (pure React)` column is the last main before any migration code (the parent of step 0.1); its
`134703f` neighbour is main re-measured in the same session (2026-11-19), so those two columns share identical
conditions and the final Solid result compares against them. Both ran today's scripts (`frontend-weight.ts` copied
into the `a0638de4` checkout, the `measure-switch` scripts from `134703f`) in detached worktrees, each server started
like `instance start` (`server/main.ts`, its own home, every agent on `openai-codex/gpt-6.2-sol`); speed numbers are
the median of three runs, the range after it is the spread of those runs (the noise).

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
