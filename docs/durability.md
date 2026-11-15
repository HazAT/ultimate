## Durability

Conversations, tool calls, subagents, and documents are committed to SQLite (`$ULTIMATE_HOME/state.sqlite`, default
`~/.ultimate/projects/<name>-<hash>/`) before anything is shown. A restart or crash resumes the run from its last checkpoint. A tool declared
`replay: "safe"` reruns after a crash; any other interrupted tool reports "interrupted" to the model. Make a tool
replay-safe only if a rerun cannot do harm, and store decisions in `api.memo()`.
A replay-safe tool says why in code: it spreads `...readOnly` or `...safeToRerun(why a rerun does no harm)` from `lib/replay.ts`, enforced by `ultimate/replay-safe-by-name`.

Each folder keeps its own conversations in that central projects directory. Homes describe themselves with `project.json` and debounced `conversations.json`; `host.projects()` (or `ultimate.projects()` in codemode) lists these manifests and live supervisor URLs without opening another project's SQLite.

Durable events (`host.emit`, see [Extension mechanics](extensions.md#durable-events)) are entries of one ownerless
conversation, titled Events, that never runs and is left out of conversation lists (open it by id); the root's `ultimate.events` document records its id and each reactor's
cursor, and `ultimate.event-feed` the latest 100 for the browser. An event commits with the change it describes, and a
reactor's cursor with its handler's writes, so those writes happen exactly once; effects outside the transaction are at
least once and must tolerate a rerun.

The web SDK's `useUiState(key, initial)` stores shared durable UI state; scroll positions and drafts stay in the browser.
The host owns `ultimate.ui` on the root conversation, persisted in SQLite and copied as of the fork entry.
