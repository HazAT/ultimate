In-place compaction for @ultimate, after Shelley's `compact_in_place`: the agent collapses older history into short notes and trims old tool outputs itself, and the turn continues on the smaller context. Pi's summary compaction then runs only when the context overflows, or when asked for.

## The tool

`compact_in_place` is deferred and named only in `agents/ultimate.md`, so only @ultimate has it.

- `index` lists the older part of the context, one row per message, a tool call sharing its row with its results: id (the entry id), role, estimated tokens, and the start of its text or each call with its output's size. The newest 60k tokens are the recent part, kept as is and never listed. Rows marked `*` (the user's and other agents' messages, notes, summaries) can be collapsed only on their own.
- `compact` takes `collapse` `[{from, to, note}]` and `trim` `[id]`. A collapse replaces the range with a user-role note `[Compacted #<conversation>/<from>-<to>] …`; a trim replaces a row's tool outputs with a placeholder naming the original entry. A range covers at most ~20k tokens unless it is one row, its note must be shorter than what it replaces, and it never reaches into the recent part. Every problem is reported at once and nothing is written until all are fixed.
- `skip` compacts nothing but hides the nudges and earlier `compact_in_place` calls.

A compaction is one `compact.edits` entry with no messages of its own: its context edits omit or replace earlier entries (Pi Durable `ContextEdit`), and the next request of the same run already reads the compacted context. Storage stays append-only: the transcript still shows every original, `ultimate.search` finds them, and going back with rewind restores them. Each compaction also hides the evidence of compacting: nudges, and earlier `compact_in_place` calls with their results; the current call stays as a receipt. `system` entries are never edited. A rerun after a crash finds its edits by call id and reports them instead of compacting again; a running summary compaction, or a compaction that landed meanwhile, refuses it.

## Nudges

Before each of @ultimate's requests, once the context (`conversations.context`) reaches 200k tokens and again at every further 100k, a `compact.nudge` entry asks for a compaction and carries the index, so the agent can go straight to `compact`. Like recall, the entry lands after the request's cutoff and the same message is appended to that request, so the prompt prefix stays cached. Dropping below a level, after a compaction, arms it again. Settings (project, else user) change the steps: `"compactInPlace": { "nudgeAt": 200000, "nudgeEvery": 100000 }`.

## Overriding Pi's compaction

Compact provides lineage's `lineage.compaction` point: lineage asks it before writing a summary, and it declines every `threshold` compaction of @ultimate. `overflow` and `manual` compactions still run lineage's summary, so a context that no longer fits is never stuck. Other conversations keep Pi's default.

## Cost

Each compaction rewrites the prompt cache from its first edited entry. With a one-hour Claude cache (writes 2×, reads 0.1× the input price), halving a 300k context pays back in about 16 requests; one nudge per 100k keeps rewrites rare.

## What the user sees

The `compact_in_place` call as a card: "Compacted in place · 412k → 188k · 6 collapsed · 14 trimmed", opening to each note with its range and the trimmed rows. A nudge is a one-line marker. `compact.edits` entries render nothing.
