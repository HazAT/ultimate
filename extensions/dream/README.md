Dream: a working session in which Ultimate processes what it learned, like people do while they sleep. The process,
for @ultimate and the dream branch, is in [DREAM.md](DREAM.md); this file is the mechanics.

## Flow

1. The user presses **Dream** (Memory panel header or ⌘K "Dream…"). The modal shows what blocks a start, live from the
   conversation list and `dream.sessions`: conversations at work besides @ultimate, or a session still open. The
   session's started card has End session until its journal is filed, so a dream that stopped early never blocks the
   next one.
2. User-only `start` refuses the same way (and while a request already waits), records a handoff request as
   `waiting` in `dream.sessions` on conversation 1 and asks @ultimate for its handoff with a `dream.handoff` input
   (below, "Dream before compaction"). Once the handoff is recorded (or 30 minutes passed) and nothing else works, the
   request's wait records session N and submits a `dream.started` input to @ultimate (request id `dream.started:N`, a
   follow-up when it is busy). Each input goes through a `dream.deliver` task created in the commit of the state it
   announces, so a crash cannot strand a request or a session.
3. @ultimate starts one branch that runs the six passes (memory, failures, tools, corrections, codify, project) as
   `dream-pass` subagents (`agents/dream-pass.md`), reporting each with `pass`. Its first report names it the
   session's `dreamer`.
4. The branch files the journal with `journal`: exactly three `learned` lines, Markdown `text` and the proposals. It
   writes once per session: a second call, even after the session ended, returns the filed journal. A passive
   `dream.journal` entry (request id `dream.journal:N`, delivered the same way) goes into @ultimate's conversation;
   its model text lists the proposal ids.
5. The branch answers @ultimate with a `Decisions:` block. @ultimate records each decision with `decide`: `approved`
   with the branch doing it, `applied` (a memory change it made with `remember`) or `rejected`.
6. Reactor `dream/landed` marks approved proposals `landed` with the sha when their branch's submission lands, in ended
   sessions too. Work merged outside a workspace is recorded with `decide {status: 'landed', sha, repo?}`: the action
   refuses a sha not reachable from HEAD in `repo` (default the project folder; the clone path for Ultimate work).
   Approved work whose result is files outside git becomes `applied` with a `reason` naming them; without one it is
   refused. A session ends once its journal is filed and no proposal is open or approved; the user can `end` it
   earlier. An ended session settles in one direction only: `decide` moves approved proposals to rejected, applied or
   landed and never reopens one; once none is approved, Fall asleep is offered and the settle check runs.

The session flow does not edit code or memory. Once its journal is filed and every proposal is settled, the user can
call `asleep { session, name? }` to start a new chapter. The name defaults to the journal's proposed `chapter`.

## Dream before compaction

When @ultimate's context passes 70%, it writes a handoff while it still remembers everything, and then a dream starts
by itself (`before-compaction.ts`). Dream ships the trigger as an ordinary context automation, **Dream before
compaction** (`condition {metric: 'context', of: '@ultimate', above: 70}`, subscriber @ultimate), made once per
chapter when the harness opens or @ultimate first starts; its id is kept in `dream.after-compaction` on conversation 1
(the kind keeps its first name). It shows in the Automations panel like any other: the threshold is edited there,
pausing it stops the dreams, deleting it is remembered (dream does not make it again), and a new chapter makes it
again only as the seed carried it (`builtIn`; paused stays paused). As any condition it fires once, re-arms 10 points
below the threshold and waits an hour between fires. `@ultimate` resolves to @ultimate's conversation, so it follows
@ultimate across chapters.

Beside it dream ships **Dream after a pause** (`condition {metric: 'context', of: '@ultimate', above: 50, idleFor:
8 h}`), kept the same way in `dream.after-pause` and carried as the seed's `builtInPause`. It dreams while the user is
away: at 8 hours keep-warm has just renewed the prompt cache, so the handoff reads @ultimate's context instead of
rewriting it, and the user's next message goes to a lean chapter instead of re-reading half a million tokens on every
request. Its fire records the pause (`waiting.automation.pause`, then `beforeCompaction.pause`, ms); once its session
settles it always asks (`result: 'ask'`, whatever `dream.asleepAfter` says), and the settled card leads with "A good
moment for a fresh chapter" and "Dreamed while you were away 9 h". The user taps Fall asleep themselves.

The automation from before this feature, **Dream after compaction** (an event on `conversations.compacted where
conversation=@ultimate`), is migrated in place by `ensureAutomation` through automations' `update`, which may now
switch a schedule, event or condition to another of these: same id, enabled state and subscribers. A lost
receipt is found by name and trigger target (the new name with a condition on `@ultimate`, or the old name and exact
event), never by threshold or subscribers, so it is never made twice.

- **Handoff.** Reactor `dream/after-compaction` sees `automations.fired` of that automation only (its id in dream's own
  document) and, unless a request already waits, a session is open, a sleep is under way or a chapter change holds the
  lock, records `waiting {at, task, automation}` in `dream.sessions` and a durable `dream.handoff-wait` task in one
  commit with a `dream.handoff` entry for @ultimate (request id `dream.handoff:<task>`). The fire's own
  `automations.fired` input wakes @ultimate, so this entry is a passive write read in that run: the handoff costs one
  turn (a second input would start a second run). The user's Dream button takes the same path without `automation`,
  and there the `dream.handoff` entry is the input that wakes @ultimate. A wait saved by the old event trigger
  (`dream.after-compaction` task) ends at once; stored sessions migrate `afterCompaction` to `beforeCompaction`
  (`dream.sessions` version 2). @ultimate records the
  handoff with `handoff {text}` (nonempty, at most 12,000 characters; a later call replaces it while the request
  waits).
- **Start.** The wait looks every 15 seconds. It starts the session through `startDreamIn` once the handoff is
  recorded, or 30 minutes after the request without one, and no top-level conversation other than @ultimate actively
  works (every refusal of the Dream button applies). Actively working (`working` in `types.ts`, from the live task
  graph) means one of the conversation's own foreground tasks is running or pending: a model response, or a tool call
  (a response waiting on its own running tool counts through the tool, so a polling `bash` or a foreground `subagent`
  wait still counts). A foreground task that only waits on other conversations' tasks or sleeps does not, and
  background tasks never do; the Dream button and its dialog use the same rule. Owned subagents are not top-level and
  never held a dream. The chapter switch (`asleep`, `switch`) keeps the strict rule below. The session records
  `handoff {task, text, at}` or `{task, missing}` and, for the automation, `beforeCompaction {automation, name, at}`;
  the `dream.started` input and card say whether the handoff came. Two hours of looking after the request the wait
  gives up (`waiting.gaveUp`, kept until the note is left, so a crash in between leaves it on the next look) and
  leaves @ultimate a quiet note through lineage's `leaveNote`; a paused or deleted automation ends it. Time the wait
  could not look does not count: each look is due 15 seconds after the last (`due` in the task's checkpoint), and a
  look more than a minute late (a host Pause holds the scheduler, or the host was down) adds its lateness to
  `waiting.unseen`, which moves both the 30-minute handoff wait and the two-hour limit. A request whose wait task
  faulted or is gone (`healed`: on open and each reload, on the Dream button, and on a built-in fire) gets a new wait
  that keeps its handoff and deadlines, instead of blocking every later dream; an aborted wait ends its request. The
  user decided this read-only analysis runs by default; the user-only `start` stays user-only.
- **Deciding.** The user decides the proposals, as for any dream; only during a hands-off goal does @ultimate decide
  them in the user's place, recording each with `decide {…, reason}` (the journal shows it). The rule lives in
  DREAM.md and `agents/ultimate.md`.
- **Worth a fresh chapter?** When the session settles (the journal filed and every proposal rejected, applied or
  landed; through `journal`, `decide` or a landing), a `dream.settled` task counts its changes: proposals `landed` or
  `applied`. Below `dream.asleepAfter` (settings, project over user, default **5**) we stay in this chapter, and a
  normal compaction comes later. At or above it, @ultimate is asked to ask the user, and the `dream.settled` card
  carries the Fall asleep section. The outcome is kept as `beforeCompaction.outcome`; only `ask` wakes @ultimate,
  `stay` is a passive entry. A session the user ended early never settles this way. Nothing here switches chapters
  without the user's tap.
- **Continuing.** The seed of a session that asked for a handoff carries it as `continues.handoff`; without one (the
  30 minutes passed) it carries @ultimate's newest compaction summary as `continues.summary` (Pi's wrapper and the
  project memory lineage appends stripped, cut at 12,000 characters). Either is at most 12,000 characters, about 3k
  tokens, beside the 6,000-token memory brief; a handoff is never cut, its limit is enforced when recorded. The new
  chapter's wake-up entry quotes it and tells @ultimate to continue that work.

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

`seed.ts` builds a JSON manifest with `buildSeed(host, session)` and atomically writes it with
`writeSeed(chapterDir, seed)` to `seed.json`. It carries the journal and proposal statuses, every root's memories
(slug collisions keep the newest `updated`, including `about-*`), open to-dos and questions, and enabled automations
and scripts, with counts for the later gate. The built-in Dream before compaction automation is not among them: the seed
says only whether it was enabled (`builtIn`), and the new chapter makes its own. Conversation docs are read through the host's exported tokens;
both trigger kinds are read through the single automations list action. Enabled schedule records keep name, optional prompt, schedule and run profile, but no subscribers: conversation ids do not survive a chapter. Schedules without a prompt become recreation to-dos.

On open, dream applies a chapter's seed in one commit with `dream.seed.applied` on conversation 1: memories keep
their sources, to-dos get fresh ids, questions become user-owned to-dos naming the old chapter and message id, and a
`dream.deliver` task writes one passive `dream.chapter` entry into @ultimate's conversation. Its text names the old
chapter's read APIs, the three learned lines and the carried counts. Reopening does not reapply those documents.

Automations are recreated through their create action after the commit, with per-name receipts in `dream.seed`.
A seed carries at most one enabled automation per name: building rejects duplicates. The destination starts empty;
before each create, dream checks existing names, so a create committed just before a crash is not repeated when its
receipt is missing. Seed application must finish before users create unrelated automations with matching names.
Project scripts are rediscovered, stopped, from trusted `.ultimate/automations` manifests by automations'
own open hook. There is no user-script adoption path: each enabled user script becomes an
@ultimate-owned “Recreate script” to-do rather than a fabricated ledger record.

### Fall asleep and switch

`asleep` refuses without a journal, with open or approved proposals, or while other top-level conversations besides
@ultimate are busy: any foreground task counts here, waiting ones included, since a switch parks whatever is live.
Names use `chapterName`; an existing name must use `switch`, never overwrite its seed. Chapter changes are serialized. Each progress update commits separately on the session as `sleep`: `seeding`, `checking`,
`backing up`, `switching`, or `failed`, with the gate checks, backup id or skip reason, error, and timestamp.

The gate writes a real seed and switch journal in a temporary home, starts it through optional `InstanceApi`, and
reads its HTTP actions without a model: root memories, open to-dos (including questions and user scripts),
automations, @ultimate's `dream.chapter` entry, and the memory brief's tokens. Passive delivery gets up to ten
seconds to settle. Lineage only publishes `briefTokens` once a root has branched, so the gate uses `estimateTextTokens`
on the fresh root's index and read instructions (the `memoryBrief` format, with no recent landings); a regression test
compares the formats. Memory briefs have no lineage cap, so the gate uses **6000 tokens**, matching lineage's tally
catch-up envelope. The instance always stops and the scratch home is removed. A failed gate gets exactly one seed rebuild and recheck; two failures stay in the current chapter.

After the gate passes, optional `CloudApi` takes a final non-forced backup of the current chapter. Missing, off or
local-only cloud records why it was skipped; a configured backup failure aborts. Only then is the seed written in
the real destination, the switch journal requested, and the host restarted. A restart failure removes the pending
journal and records `failed`; the seed remains available to retry. No action performs a real switch in its caller.

Once the new chapter has applied its seed, its open starts the chapter's first cloud backup in the background, when
`CloudApi` reports backups on (not off, satellite or local-only) and the chapter has no backup yet: none recorded in
its `cloud-backup.json`, none in the Worker's register (a backup registered just before a restart). Every open of a
seeded chapter checks again, so a backup a restart cut short runs on the next open, and one
@ultimate already took stands in for it; cloud's one-at-a-time lock refuses a second concurrent upload. The status
line's "backed up …" shows it; failures arrive as cloud's own notice. The gate's preview never backs up.

`chapters` returns `{ active, number, newest, chapters: [{ name, number, createdAt? }] }`. User-only `switch { chapter }`
refuses active or unknown names, busy conversations here, and targets with work in flight (`requestChapter`). It
journals and restarts without building a seed or backing up. A failed restart removes its pending journal and throws.
A successful restart never returns: the new host opens the requested chapter.

## Actions

`refs.ts` holds the documents and actions: `start`, `end`, `asleep`, `switch` (user-only), `chapters`, `pass`, `journal`, `decide` (with an optional one-line `reason`),
and `stats`, which reads tool calls from `<home>/trace.sqlite` read-only: calls, failures and mean duration per tool,
the 20 most frequent errors, and enabled tools never called in the trace's window (7 days or 200k rows).

On open, a sleep a restart stopped during its gates (`seeding`, `checking`, `backing up`) becomes `failed`: nothing
switched, and Fall asleep can be tried again.
