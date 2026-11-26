## Durability

Conversations, tool calls, subagents, and documents are committed to SQLite (`$ULTIMATE_HOME/state.sqlite`, default
`~/.ultimate/projects/<name>-<hash>/`) before anything is shown. A restart or crash resumes the run from its last checkpoint. A tool declared
`replay: "safe"` reruns after a crash; any other interrupted tool reports "interrupted" to the model. Make a tool
replay-safe only if a rerun cannot do harm, and store decisions in `api.memo()`.
A replay-safe tool says why in code: it spreads `...readOnly` or `...safeToRerun(why a rerun does no harm)` from `lib/replay.ts`, enforced by `ultimate/replay-safe-by-name`.

An effect outside the store (a post to another Ultimate, a push, a git or file change) is a durable task too:
`defineEffect(name, run, settle?)` from `lib/effect.ts` defines it, and the commit that decides the effect creates it
with `tx.createTask`, so the effect exists exactly when the decision does. It runs at least once, again after a crash
before its outcome commits, so `run` is idempotent by its `key` (the task id) or its input; `settle` writes the outcome
in the task's terminal commit, and `{ ok: false, error: 'stopped' }` when it is aborted. `effectResult` waits for one.
Server code never starts work and drops it (`ultimate/no-unowned-work`): what open derives again says so with
`rebuiltOnOpen(why, work)`, what belongs to this process only (a request, a stream, a child, shutdown) with
`inProcess(why, work)`, both from `lib/errors.ts`.

Each folder keeps its own conversations in that central projects directory. Homes describe themselves with `project.json` and debounced `conversations.json`; `host.projects()` (or `ultimate.projects()` in codemode) lists these manifests and live supervisor URLs without opening another project's SQLite.

Durable events (`host.emit`, see [Extension mechanics](extensions.md#durable-events)) are entries of one ownerless
conversation, titled Events, that never runs and is left out of conversation lists (open it by id); the root's `ultimate.events` document records its id and each reactor's
cursor, and `ultimate.event-feed` the latest 100 for the browser. An event commits with the change it describes, and a
reactor's cursor with its handler's writes, so those writes happen exactly once; effects outside the transaction are at
least once and must tolerate a rerun.

The web SDK's `useUiState(key, initial)` stores shared durable UI state; scroll positions and drafts stay in the browser.
The host owns `ultimate.ui` on the root conversation, persisted in SQLite; it keeps only its latest value and a fork starts without it.

A mutable document that is not rewindable sets `checkpointWhen: checkpointEvery(100)` (`shared/checkpoint.ts`): every
100 changes it stores a complete base, which drops its older revisions, so a cold read replays at most 100 deltas.
Each op a tab sends carries that tab's next `seq`, kept when the page-exit request copies it. `ultimate.ui-writers`
records each tab's newest `seq` per key in the commit that writes the key, and `POST /api/ui` skips an op that is not
newer, so a late or repeated request never rolls a key back, across restarts too. The newest 1000 entries are kept.
