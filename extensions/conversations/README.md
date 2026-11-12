What each conversation is about: titles, summaries, features and reply summaries, the overview the sidebar reads,
and concluding and resuming conversations. Several branches run at once as separate agents; lineage roots keep their shared context without running turns.
A summary model (GPT-6 Luna by default) automatically gives top-level conversations concise titles and sidebar summaries, and describes each final reply without
changing the main agent. A conversation turns these automatic triggers (intent, spawn, steer and completed reply) off with
`setAutomaticSummaries(tx, id, false)` on the service: it then schedules no summary task, a task admitted before settles
without writing, and its title stays as set, with no automatic summary, feature, activity, reply summary or abstract.
Explicit `askSummaryModel` calls are unaffected. Standing agents and landers are off (their `@name` titles stay fixed), side
chats are off (only Summarize & inject asks the model), and a definition with `summaries: false` turns off the
conversations it configures (see the [subagents README](../subagents/README.md)).

## Sidebar

The sidebar, its rows and the phone title bar's @ultimate button live in the [sidebar](../sidebar/README.md) extension, which
reads this extension's overview, titles and actions. `ui.tsx` declares the points it renders for optional extensions:
`ConversationPhase` (a working conversation's phase) and `ConversationTask` (the plan task a child works on).

It provides the core's `ComposerPlaceholder`: an idle standing agent's composer reads "Message <title>…" by its
definition's `title` (`standing.tsx`), in the dock, the full view and on a phone alike; @ultimate's
keeps the core's text. It also provides `EmptyTranscript`: before its first message, a standing agent's transcript shows
its mark, title and `@name` (`standing.tsx`) instead of the core's card of repo, model and host.

## Server facet

`context.ts` keeps `conversations.context` (`ContextUsageDoc` in `api.ts`, `ContextDoc` in `refs.ts`) on each
conversation: `tokens`, the current model's `window`, their `percent`, and `estimated`. Answers measure prompt tokens
(input plus cache reads and writes, not output); compaction and reset estimate the next request's system prompt,
tools and new context until another answer. Model changes update the window. Unknown fields are absent. `at` is Unix
milliseconds (the answer/head message timestamp, or when the estimate was made if absent); `entry` identifies the
source assistant or head entry. A fork starts at `{ at: 0 }`, without inheriting its parent's measurement.
A watcher follows Pi's commits and writes the document in its own commit, serially per conversation, only when it
changes. On open, background reconciliation scans bounded pages and recovers missing or stale source entries without
blocking startup. The status line reads this same document, independent of which browser is open.

`compactions.ts` emits `conversations.compacted` `{ conversation, entry, reason? }` (`Compacted` in `refs.ts`) for
each compaction summary Pi places. Pi appends it in its compaction task with no hook in that commit, so a commit
watcher emits it in a commit of its own: a crash between the two loses the event, nothing repeats it. The same
watcher raises a notice when a compaction its conversation owns (background or manual) fails; a blocking one's failure
ends the run waiting on it, which reports itself.

`activity.ts` maintains `ultimate.metadata`'s `inputTitle`, `inputAt`, and `answerAt` from committed
history; core only serves those fields, preferring an explicit `title` over the input title. Reset and
compaction cut the active title source but preserve activity times from earlier history. On open, the
projection reconciles every conversation, including inherited fork history, and only commits metadata
when the derived fields change.

All input detection uses `isInput` in `lib/entries.ts`: Pi Durable marks entries placed from input
submissions with `input: true` (a small upstream patch). Pi's own `pi.user` input kind also counts,
keeping existing history usable. Typed inputs count without an extension kind list; user-role writes
such as lineage notes do not.

The `conversations` prompt section goes to every top-level conversation (not a subagent). It names the
conversation's own id, says other conversations may share the checkout (check `git status`, never revert others'
changes), and points to codemode's `ultimate.conversations()` (title, cwd, busy, concluded), `ultimate.entries(id)` and
`ultimate.projects()`. It lists no conversations: its text never changes, because every system prompt change costs the
prompt cache (on the Claude Code path a full rewrite of the context), and a list changed with every branch start,
conclude and retitle. Concluded ids live in UI state `ext.conversations.concluded`.

Actions are callable from the browser with `api.action` or by agents with
`await ultimate.action('conversations', 'conclude', {ids: [N]})` in codemode. The browser never rewrites the concluded
list. No state-key migration runs automatically.

- `conclude {ids:number[]}`: validates top-level conversations (unknown ids, subagents, listed roots and standing agents
  throw, refusing the whole call; a standing agent is one marked by the service's `setStanding`, which subagents calls
  for residents and workspaces for landers, never by its label or title), deduplicates and
  adds them to `ext.conversations.concluded` in one transaction. Then it stops them: `Conversation.abort({ background:
  true })` aborts every task they own, subagents and their reporters included, withdraws queued inputs and waits until
  they are idle. An agent concluding the tree it runs in is not stopped, since it would wait for itself. Next it stops
  the previews the tree started through the `conversations.previews` extension point (instance provides it), and frees
  their resources through `conversations.release`, which workspaces provides (its worktrees, keeping unlanded or
  uncommitted work). Returns `{ concluded, stopped, previews, kept }`: `stopped` lists the conversations of the tree
  that were busy, `previews` the stopped instance ids, `kept` which checkouts remain and why. Processes an agent started
  by hand (`nohup`, `systemd-run`) are not tracked and keep running. Only this action stops work: the automatic
  conclude of a landed branch (lineage) and of an ended side chat call `concludeIn` once the conversation is idle.
- `resume {ids:number[]}`: transactionally removes ids and their concluded ancestors from the list, returning
  `{ resumed: number[] }` for the removed ids. The next input recreates a released checkout from the target tip;
  Resume itself does not create one.

The single-conversation actions below reject bad args, unknown conversations, and subagents:

- `rename {id, title}`: sets the `ultimate.metadata` title, with whitespace runs (newlines too) collapsed to one space,
  trimmed, and cut to at most 160 characters; a blank title removes it, so the first message names the conversation
  again and re-enables automatic titles on the next scheduled summary. Nonblank renames take manual ownership, even
  during generation. Returns `{ ok: true }`.

## Automatic summaries and reply summaries

Title/summary requests also classify a 1–3 word product feature label for top-level conversations.
The label is exposed in the overview and kept unless the work clearly moves to another feature: tags group landings
in the sidebar, so the summary model, not code, decides that it moved. Titles name the goal, not the latest step or
status. An accepted change of an existing tag appends `conversations.feature-changed` `{ feature, from, model?, at }`,
shown as “Tag changed from … to …” beside “Title changed”; the first tag is not a change.

All four triggers request work through the typed, transaction-scoped `requestSummary(tx, host, id, request)`
helper in `summary.ts`: `intent`, `spawn`, `steer` and `reply`. The existing version-1 task inputs/checkpoints are
preserved; intent and steer add optional input fields, so live reply and spawn tasks remain resumable.

`GenerationTask.beforeRequest` requests an initial title and intent summary before the main model request.
It inspects the conversation's own stored entries since the current head marker (not inherited fork history):
exactly one user input and no assistant reply, only in top-level conversations. A durable `intentRequested` flag prevents tools, request retries and recovery
from requesting it again. Established conversations are not backfilled on later inputs, including when the summary
model becomes available later.
Intent describes the requested goal, not completed work; it can publish while the main agent is busy.
It does not assess a reply or increment exchanges. New input (including queued input),
a reset, or a superseding spawn/reply request makes a held result stale; compaction does not.
Accepted intent appends `conversations.intent-summarized` with `{ summary, model?, at }` (Unix milliseconds),
atomically with summary/title acceptance and task settlement. The transcript shows a quiet “Intent: …” row with local time
and a full-date tooltip. This custom system entry has no model contribution; it survives replay without duplication.

The same hook, in its own transaction, requests a steer refresh when an input from the user or another agent
(`pi.user`, `board.message`) joined the running run: the run's inputs number two or more and the newest is not the
`steered` one already considered. A subagent report or other typed input that wakes the run is recorded as considered
but asks nothing. The refresh describes the goal as the new instructions change it, from those instructions, recent
text and the previous summary and feature, and publishes while the run goes on, like a spawn refresh: newer input or a
reset makes a held result stale, which is its debounce. It costs one summary request per steer; an accepted one
appends `conversations.summarized`.

The `GenerationTask.onYield` hook schedules a background observer. It waits for generation to settle and
only counts an exchange when an input submission completed with that answer (not an intermediate yield).
The [summary model](#summary-model) describes each completed reply in one `activity` line, including subagent replies,
in a background task. It judges nothing: whether a conversation waits, is done or failed comes from committed records
(messages’ `conversationState`).
Top-level conversations also get a title and summary with every completed exchange, in the same request.
For a top-level non-root conversation in a lineage tree, that same request produces an abstract after every completed
exchange. It uses the original branch intent, previous abstract and transcript:
Ask, Diverged (agreements, approach/library or scope changes, or none), State (including named commits), Areas and Open
questions, capped at 1200 characters. Acceptance calls `abstract` of the `conversations.trees` extension point, which lineage provides, in the same transaction as the
reply summary, with `at` pointing to the answer entry, and saves the text in summary state. A newer abstract updates
the open one in place until a landing freezes it (see the lineage README); the root never reorders. Roots, owned
conversations such as subagents, and conversations outside trees such as landers produce no abstract. Neither do
stale answers, failed or interrupted exchanges, or missing lineage or summary models. Exchange and intent detection use own entries, so inherited inputs and answers
do not count as the branch's work.
A summary delayed by newer work is included with the next current reply. Tools and partial replies do not trigger reply summaries.
Successful subagent creation additionally schedules a parent title/summary refresh in the creation transaction,
before either foreground waiting or background return. It describes the plan and delegation now starting, using
recent visible text plus the agent/task, without publishing a final-reply activity or counting an
exchange. The durable action receipt deduplicates replay; failed starts,
messages and waits do not schedule it. If conversations or the summary model is unavailable, child creation proceeds
without it.
Spawn refreshes share the summary task, response receipt and usage accounting. They may publish while the parent
is busy, but reset, newer input or a superseding summary request invalidates them; manual titles stay protected.
An accepted spawn refresh appends `conversations.summarized` `{ summary, model?, at }`, also when the title stays.
The request reads the original request (kept even when compaction removed it from context), recent
user/assistant text and the previous summary, not tools, images or thinking.
It times out after 60 seconds. Activity, title and summary are checked and shortened for display.
New work or a reset can make a result stale; only a reset ends an exchange.
Subagents get activity only; history forks are excluded.
The summary model can name an untitled conversation or update its own last generated title.
API titles, renames and creator-given labels are kept. A blank rename restores automatic naming.
Each accepted automatic title change appends a `conversations.title-changed` entry with `{ title, model?, at }`
(`at` is Unix milliseconds), atomically with the metadata update and task settlement. The transcript displays
“Title changed to …” with the local time and a full-date tooltip. This is an automatic system action, not an
agent-triggered tool or model message. Unchanged titles, protected manual titles, stale results, failures and
an unavailable summary model produce no action. Entries survive reload/restart without duplication; old changes are not
backfilled and manual renames are not logged.
The task saves the provider response before parsing it and adds reported usage even for stale or invalid results.
Replaying a saved response does not count it again. Crashing before it is saved can repeat the request.
State survives reloads and restarts. Failed requests preserve the last summary and retry on the next reply.
When the summary model is unavailable in the model runtime, summaries and assessments are skipped quietly, without a
task. A task that finds no available model before it chose one settles quietly too: no discard entry, no error status.

## Summary model

`summaryModel` in `~/.ultimate/settings.json` or the project's `.ultimate/settings.json` (project wins, and only once
the project is chosen) names the model for titles, summaries, reply summaries and tree abstracts as
`provider/id[:thinking]`, an exact provider and model id with an optional Pi thinking level, clamped to what the model
supports (medium when omitted). Unset, it is `DEFAULT_SUMMARY_MODEL`: GPT-6 Luna with medium thinking through the
current OpenAI provider (including Sign in with ChatGPT). `summary-model.ts` reads it when a request is considered and again when a
task starts asking, so changes apply to the next request without a restart. Each task stores the resolved
`{ provider, id, thinking }` in its `model` memo before asking: a resumed task asks the same model even after the
setting changed. A malformed value shows one notice and turns summaries off; a well-formed model that is unknown or
not logged in skips quietly. Usage counts under the response's `provider/model`.

The "Summary model…" command opens a picker of logged-in models (rows from the models extension's picker) that shows
the effective value and its source (default, `~/.ultimate/settings.json`, or the project's settings). Picking a model,
or Use the default, writes only the user file, never the project's tracked `.ultimate/settings.json`. While project
settings decide the model, the dialog says "set by project settings", disables picking and Use the default, and its
footer names the project file to edit. Two actions back it:

- `summaryModel` → `{ value, source: 'default' | 'user' | 'project', default, path? }`; `path` is the project file
  when it decides the value.
- `setSummaryModel {value}`: a `provider/id[:thinking]` string, or `null` to remove it; returns the new effective
  setting. It refuses while a project setting applies. Writes reuse onboarding's atomic settings writer
  (`extensions/onboarding/settings.ts`).

`summary-model-ref.ts` parses the value without node imports, so the web facet shares it: only a recognized final
thinking level is stripped, so model ids may contain colons (`x-ai/grok-4.3:batch:high`).

It provides the `conversations` service: `subject(id)` returns a conversation's current title, summary and feature,
which workspaces snapshots for each submission. `concluded(caller)` returns a `Promise<Set<ConversationId>>`
from the server-owned concluded list, used by workspaces to release checkouts on open.
`generatedTitle(tx, id, title)` marks a new branch's or root's intent title as generated, so its summary may replace
it; lineage calls it from its `named` reactor. This extension declares two extension points in `api.ts`:
`conversations.trees` (`rootOf`, `branchOf`, `abstract`; lineage provides it) and `conversations.release`
(workspaces provides it), so it depends on neither.

## How status and summaries flow

Every displayed status traces back to committed Pi Durable records. Hooks and tasks write records; documents are
projections that can be rebuilt from those records at any time; no process-local state decides what a row shows.

```text
GenerationTask hooks ─▶ conversations.summary task ─▶ entries + Summaries doc ─┐
 (beforeRequest, onYield)   (byTaskId on its entries)                          ├─▶ Overview doc ─▶ sidebar
input submission (done/unanswered) · pi.live · pi.inbox · pi.reset ────────────┘
```

- **Exchange**: the input submission placed last in the transcript (greatest entry id), read newest first with the
  host's `scanSubmissions`. A newer steer can be placed before an older queued follow-up, so the scan keeps reading a
  bounded window of older submissions past the first placed one. `done` carries its `answer`: the row is `answered`,
  with or without a summary model. `unanswered` is `error`, except when the user aborted it or a reset or stale write
  ended it. A later `pi.reset` entry ends the exchange; compaction does not.
- **Run state**: `pi.live.run` is `working`; a user item in `pi.inbox` is `queued`.
- **Summary task outcomes** are entries appended in the commit that settles the task, so each carries `byTaskId`
  (the summary task, whose input names the generation it observed). None contributes to the model context:
  - `conversations.assessed` `{ inputId, answerId, activity, summary?, model?, at }`: an accepted reply summary;
    `summary` when the reply also refreshed the conversation's summary. Entries from before the judgement was removed
    also carry `value`, which nothing reads.
  - The `summaries {id}` action reads them back for the sidebar's history popover: the summaries recorded by intent,
    spawn and reply entries, newest first, at most 50, led by the current one when no entry recorded it (`at` absent).
  - `conversations.summary-discarded` `{ reason: 'stale' | 'error', cause, model?, at }`: a received result superseded
    by newer work or a reset (`stale`), or a failed or aborted request (`error`). A task superseded before it asked the
    summary model leaves no entry.
  - `model` is the `provider/model` the response names, else the summary model the task chose; absent only when no
    model was chosen.
  - `conversations.title-changed`, `conversations.feature-changed`, `conversations.intent-summarized` and
    `conversations.summarized`, as above, with
    `model` likewise.
    The transcript shows each as one quiet line with its local time.
- **Summaries** (`ultimate.conversation-summaries`) keeps the current summary, activity and their statuses
  (`pending`, `ready`, `stale`, `error`) plus the exchange count. Stale shows nothing in the sidebar; error shows
  "unavailable · retries after next reply".

## Shared sidebar index

`ultimate.conversation-overview` keeps sidebar rows in the root conversation document.
Each row's `runState` is `working`, `queued`, `answered`, `error` or `idle`, with the input and answer ids of the
exchange, the summary and activity. Answered means a reply arrived.
One root-document stream serves all rows. Titles, timestamps, child links and agent labels come from the core
conversation list.
A commit only selects which rows to derive again: any committed submission, `pi.user`, `pi.reset` or `pi.compaction`
entry, `pi.live.run` or `pi.inbox` change, or `Summaries` change. Derivation reads the records themselves, so a row
built live equals the row a fresh open builds. On open, every conversation is derived anew without requesting old
summaries.
