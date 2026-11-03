Dream: a working session in which Ultimate processes what it learned, like people do while they sleep. The process,
for @ultimate and the dream branch, is in [DREAM.md](DREAM.md); this file is the mechanics.

## Flow

A dream is ordinary work; code keeps only which branch is the dream, so its end can show the user Fall asleep:

1. **Asked for.** The user tells @ultimate to dream, presses **Dream** (Memory surface header or ⌘K "Dream…"; user-only
   `start` gives @ultimate a `dream.requested` input), or a built-in automation fires (below).
2. **Dreamed.** In that turn @ultimate writes its handoff into the prompt of one dream branch, which runs the six
   passes as `dream-pass` subagents (`agents/dream-pass.md`) and answers with its journal and a `Decisions:` block.
   The `dream-branch` reactor reads each `lineage.branched` event, from the start of the log: a branch @ultimate
   started in a turn that answered a `dream.requested` entry newer than the last dream's (its stamp's entry, read back
   to the turn's start) becomes `dream.next.dream { branch, requested, at }`.
3. **Decided.** @ultimate weighs in and the dream branch asks the user with a questions card; approved ones become ordinary branches or
   `remember` batches.
4. **Woke.** Once the dream branch is concluded, the sidebar (`awake.tsx`) and the status line show "The dream is
   done" with **Fall asleep…**, until a chapter is prepared after it or the user dismisses it (user-only `dismiss`).
   Fall asleep calls user-only `ready`, which wakes @ultimate with a `dream.ready` input asking it to prepare.
5. **Prepared.** @ultimate calls `prepare {chapter, learned, handoff}`: the chapter's name, three learned lines and a fresh handover (at most 12,000 characters). It is kept in
   `dream.next` on conversation 1 and shows as the `dream.prepared` card in @ultimate's conversation, pinned in the
   status line until it is slept into. A second `prepare` replaces it.
6. **Asleep.** The user presses Fall asleep on the card (`asleep`, below).

### Built-in triggers

Dream ships two ordinary context automations that subscribe @ultimate (`built-ins.ts`): **Dream before compaction**
(`condition {metric: 'context', of: '@ultimate', above: 70}`) and **Dream after a pause** (`above: 50, idleFor:
8 h`; at 8 hours keep-warm has just renewed the prompt cache, so the handoff reads it instead of rewriting it). Each
is made once per chapter when the harness opens or @ultimate first starts; their ids are kept in
`dream.after-compaction` and `dream.after-pause` on conversation 1. They show in the Automations panel like any other:
thresholds are edited there, pausing one stops its dreams, deleting one is remembered (dream does not make it again),
and a new chapter makes them again as the seed carried them (`builtIn`, `builtInPause`; paused stays paused). A lost
create's receipt is found by name and trigger target, never by threshold or subscribers, so none is made twice. As
any condition, each fires once, re-arms 10 points below its threshold and waits an hour between fires.

A fire's own input wakes @ultimate; reactor `dream/requested` adds a passive `dream.requested` entry beside it (request
id `dream.requested:<automation>:<fire>`), which says what a dream is and where its workflow lives, so the fire costs
one turn.

## Chapters

A chapter is one database of a project home; one is active at a time and the others stay live, so any chapter can be
made active again (`lib/chapters.ts`).

- The first chapter, `the-beginning`, is the home itself: `<home>/state.sqlite` and `trace.sqlite`. A home that never
  switched has no `chapters.json` and nothing moves. Later chapters live in `<home>/chapters/<name>/`.
- `<home>/chapters.json` `{ active, chapters: [{ name, createdAt? }] }` lists them in creation order; the newest is
  the last.
- A switch is journaled: `requestChapter(home, name)` writes `pending-chapter.json` `{ to }`, then the host restarts.
  `prepareHarness.open` finishes the journal before storage opens: a new chapter gets its database, with record ids
  continuing after every earlier chapter's, so `#123` names one conversation whichever chapter is open. An
  interrupted switch finishes on the next open.
- `requestChapter` refuses while the target chapter has a live foreground task: that work would resume the moment it
  opens.
- The host exposes the active chapter as `host.chapter` (`name`, `number`, `newest`, `dir`, `database`, `trace`).
- Cloud backups are per chapter: the first chapter keeps the project key and `<home>/cloud-backup.json`; a later one
  backs up as `<key>@<name>` with its record in its own folder. The status line names a later chapter.
- `pnpm reset` moves every chapter aside with the first.

### Seed

`seed.ts` builds a JSON manifest with `buildSeed(host, prepared)` and atomically writes it with
`writeSeed(chapterDir, seed)` to `seed.json`. It carries the prepared learned lines and handover (`continues`), every
root's memories (slug collisions keep the newest `updated`; a lost `about-*` memory fails the seed), open to-dos and
questions, and enabled automations and scripts, with counts. The built-in dream automations are not among them: the
seed says only whether each was enabled, and the new chapter makes its own. Conversation docs are read through the
host's exported tokens; both trigger kinds are read through the single automations list action. Enabled schedule
records keep name, optional prompt, schedule and run profile, but no subscribers: conversation ids do not survive a
chapter. Schedules without a prompt become recreation to-dos.

On open, dream applies a chapter's seed in one commit with `dream.seed.applied` on conversation 1: memories keep
their sources, to-dos get fresh ids, questions become user-owned to-dos naming the old chapter and message id, and a
`dream.deliver` task wakes @ultimate with one `dream.chapter` input (the morning card). Its text names the old
chapter's read APIs, the three learned lines, the carried counts and the handover, and tells @ultimate to continue
that work. Reopening does not reapply those documents.

Automations are recreated through their create action after the commit, with per-name receipts in `dream.seed`.
A seed carries at most one enabled automation per name: building rejects duplicates. The destination starts empty;
before each create, dream checks existing names, so a create committed just before a crash is not repeated when its
receipt is missing. Project scripts are rediscovered, stopped, from trusted `.ultimate/automations` manifests by
automations' own open hook; each enabled user script becomes an @ultimate-owned "Recreate script" to-do.

### Fall asleep and switch

User-only `asleep { name? }` refuses without a prepared chapter, while any top-level conversation is busy (@ultimate
included: a switch parks whatever is live, and parked work keeps the chapter left behind from being switched back to),
or when the name (default: the prepared one) already exists; an existing chapter is reached with `switch`. Chapter
changes are serialized. Each step commits as `sleep` in `dream.next`: `seeding`, `backing up`, `switching`, or
`failed`, with the backup id or skip reason, error and timestamp.

After the seed is built, optional `CloudApi` takes a final non-forced backup of the current chapter. Missing, off or
local-only cloud records why it was skipped; a configured backup failure aborts. Idleness is checked again, the seed
is written in the destination, the switch journaled and the host restarted; the restart's approval checks idleness
once more and holds the scheduler. A restart failure removes the pending journal and records `failed`; the seed stays
for a retry. No action performs a real switch in its caller. On open, a sleep left `switching` becomes `asleep` when
its chapter exists, else `failed`; one a restart stopped earlier becomes `failed`.

Once the new chapter has applied its seed, its open starts the chapter's first cloud backup in the background, when
`CloudApi` reports backups on (not off, satellite or local-only) and the chapter has no backup yet: none recorded in
its `cloud-backup.json`, none in the Worker's register (a backup registered just before a restart). Every open of a
seeded chapter checks again, so a backup a restart cut short runs on the next open, and one @ultimate already took
stands in for it; cloud's one-at-a-time lock refuses a second concurrent upload. Failures arrive as cloud's own notice.

If the new chapter is off, the morning card's Discard path offers **Back to** the previous chapter, which stays as it
was left.

`chapters` returns `{ active, number, newest, chapters: [{ name, number, createdAt? }] }`. User-only `switch { chapter }`
refuses active or unknown names, busy conversations here, and targets with work in flight (`requestChapter`). It
backs up and restarts without building a seed. A failed restart removes its pending journal and throws. A successful
restart never returns: the new host opens the requested chapter.

## Actions

`refs.ts` holds the document and actions: `start`, `ready`, `dismiss`, `asleep`, `switch` (user-only), `prepare`,
`chapters`, and `stats`,
which reads tool calls from `<home>/trace.sqlite` read-only: calls, failures and mean duration per tool, the 20 most
frequent errors (each with its two newest calls as `#<conversation>/<entry>` and the start of its args), and enabled tools never called in the trace's window (7 days or 200k rows).
