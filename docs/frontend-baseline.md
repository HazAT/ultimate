## Front-end baseline for the Solid 2 + ui-sdk migration

The migration's purpose is a front end that is more robust, faster, simpler and smaller than the React one. Each step
reports its delta on the numbers below against this baseline, and after the UI kit and the first batch of extensions a
decision gate compares the migrated extensions with their React originals on lines, renders and bundle size.

Measured on main at `1c5d056` (step 0.3 landed; three Solid files: the keep-warm chip and two kit controls), 2026-11-19,
on one machine. Speed numbers drift with machine load: compare within one session, medians of repeated runs.

### Code and bundle: `node scripts/frontend-weight.ts`

Non-blank lines of `web/src/**/*.{ts,tsx,css}` and every `extensions/*/**/*.tsx`, tests excluded; the production
bundle as `server/web-build.ts` builds it for this checkout, with no user or project extensions. Entry assets
(`entryAssetsGzip`) counts only the JS and CSS the HTML links; the facets the page loads at startup come on top, so it
is not the whole first load.

| Measure                        |  Baseline |
| ------------------------------ | --------: |
| Front-end lines                |    50 526 |
| of which `web/src`             |    10 793 |
| of which `extensions/**/*.tsx` |    39 733 |
| of which Solid (`.solid.tsx`)  |       126 |
| Files                          |       269 |
| Bundle JS, all chunks          | 13 658 KB |
| Bundle JS, all chunks, gzip    |  2 923 KB |
| CSS, gzip                      |     24 KB |
| Entry assets (JS + CSS), gzip  |    449 KB |

### Conversation switching: the `measure-switch` skill

A paused copy of the project's first chapter (1.5 GB), conversations 30726, 97078, 171689 and 32858 (6 200, 6 143,
4 665 and 2 337 entries), start at 1, `--rounds 3`, two runs:

| Median      |    Cold |    Warm |
| ----------- | ------: | ------: |
| `settledMs` |     781 | 245–271 |
| `longMs`    | 289–297 |   58–59 |
| `eventKb`   |   1 724 |     511 |

### A streaming turn: `renders.ts --send`

A fresh preview, one real turn (`"Reply with three short paragraphs about Solid signals, no tools."`), two runs:

| Per `ops` event (the streamed transcript) |                        Baseline |
| ----------------------------------------- | ------------------------------: |
| React components rendered, median         |                           90–92 |
| React components rendered, max            |                         820–980 |
| Main-thread task, median / p95            |              5.2–5.9 ms / 35 ms |
| Top owners                                | `App`, `Transcript`, `Composer` |

`App` re-rendering on every streamed op is the shell reading a whole object; Solid's per-path updates are meant to
remove exactly that, so this is the number the core switch (phase 3) should move most.
