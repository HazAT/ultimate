External orchestration bridge for Ultimate: gives an external agent (such as Antigravity over MCP or CLI) a passive standing inbox conversation so it can directly start and steer coordinator branches, message @ultimate, receive branch reports and landings without waking an internal LLM turn, and manage project memory.

## How it works

The extension creates one passive standing conversation (`orchestrator.state` on conversation 1) with `model: null` and implements the `messages.passive` extension point. Deliveries from coordinator branches (answers, decision requests, reports, landings, and question pointers) and replies from `@ultimate` are written directly to that conversation's transcript without running a model turn.

## Actions

- `ensure { name? }` → `{ id, name, root?, ultimateId? }`: create or return the passive orchestrator conversation.
- `branch { prompt, title?, root?, family?, isolated?, name? }` → `{ id, message, orchestratorId }`: start a `branch · coordinator` owned by the external orchestrator (internal `@ultimate` is not woken).
- `message { to, text, reply?, steer?, name? }` → `{ message, orchestratorId }`: send a message from the orchestrator to `#<id>` or `@ultimate` (or another standing `@name`). When answering an owed decision request from a branch, it settles that request as a reply automatically.
- `note { to, text, name? }` → `{ ok: true, orchestratorId }`: leave a non-waking note on `#<id>` or `'root'`.
- `inbox { since?, limit?, name? }` → `{ orchestratorId, name, cursor, items, branches, openQuestions }`: read new inbox entries after entry id `since`, plus active orchestrated branches and open user questions.
- `wait { since?, limit?, timeoutMs?, name? }` → `OrchestratorInbox & { timedOut }`: wait on commit notifications (no polling) until a new inbox entry arrives after `since` or `timeoutMs` elapses (default 20 s, max 25 s).
- `remember { ops, root? }` → `{ root, summary }`: apply an atomic memory batch to the project root.
- `memory { root? }` → `{ root?, memories }`: read the project root's memories.

Mutating actions (`ensure`, `branch`, `message`, `note`, `remember`) are marked `userActions` so internal agents cannot impersonate the external orchestrator through codemode.
