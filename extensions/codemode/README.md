Run an async JavaScript function body in a fresh QuickJS/WASM sandbox. Only injected functions can access the host. Prefer it for dependent or parallel tool calls, filtering large outputs, and inspecting Ultimate; use ordinary tools for a single simple operation.

`await tools.<name>(args)` calls the conversation's currently resolved tools, except codemode. Nested calls share the parent durable task (no separate durable tool task), bypass `beforeTool`/`afterTool` hooks, and capture their output privately. Failures reject with the tool's error text. Tools declaring an `outputSchema` and returning `structuredContent` resolve to that JSON; other tools resolve to text. These are Ultimate's own fields, separate from Pi Durable's `structuredOutputSchema` and `structuredOutput`.

`tools.screenshot` and `tools.browser` resolve to `{ title, image?, file?, outcomes }`. `image` is missing when the PNG cannot be resized under the inline image limit; only the saved `file` path comes back, and `image(undefined)` throws. Check it first: `if (shot.image) image(shot.image)`.

`text(value)`, console methods, `image(data)`, and the return value produce model-visible output. Nested-call completion lines stream to `pi.live`; final details contain `{ calls: [{ name, args, status, ms, conversationId?, background? }], value?, error?, subagentAnswers? }`. Script failures preserve output and QuickJS's `codemode.js:<line>` stack. Interrupted scripts are not replayed: Durable returns an interrupted result with the committed partial log. Ordinary nested side effects are never rolled back.

The first line may be `// @options: {"timeout_ms":30000,"max_output_tokens":2000}`. Default timeout is 60 seconds, text output budget is 10,000 estimated tokens, and VM heap limit is 256 MiB. Conversation abort and sandbox deadlines cancel nested work through its context.

## Yielding to steering

When a nested `tools.subagent` result has `details.yielded: true`, codemode synchronously aborts only its sandbox, before returning any value or error to QuickJS. The installed pi-codemode runtime clears pending host replies and terminates the worker before resolving the abort. Script `catch`/`finally`, sequential statements, and `Promise.all` continuations cannot resume. In-flight nested work receives cancellation; child lifetimes and durable answer delivery remain the subagent backend's responsibility.

The outer tool succeeds with the explicit message: **Script yielded to steering; subagents still running; remaining script not executed; prior side effects may have happened.** Details include `yielded: true` and `pendingSubagents: [{ conversationId, background? }]`, preserving the yielding child's ID and known IDs from other cancelled waits. The corresponding call status is `yielded`; other pending calls are `cancelled`. A cancelled start may not yet have returned its new child's ID; the backend must retain that ownership durably. Codemode neither aborts the parent invocation nor reads or consumes steering. Original conversation cancellation still cancels the script, rather than turning into a successful yield.

Successful nested subagent results may carry `details.answerId` (a durable answer entry ID). Only a successful, non-yielded outer completion emits the deduplicated IDs as `details.subagentAnswers: number[]`. Yielded and failed results omit this receipt, even if an earlier child completed in the same script; interrupted tasks likewise do not acknowledge those answers. Nested answers remain private unless the script prints or returns them. The backend queues reports with stable answer IDs immediately, then its `afterTools` hook reads committed tool results and atomically withdraws reports acknowledged by these receipts before the Pi tool-round boundary. It does not wait for the outer task's terminal outcome to enqueue delivery. Codemode does not handle delivery, consume steering, or import the backend runtime.

## Introspection and actions

Only inside codemode (not standalone model tools):

- `ultimate.system()` — machine, process, persistence, resources, build identity.
- `ultimate.projects()` — project folders, their top-level conversation summaries, and URL when running (JSON manifests only, not other stores' SQLite).
- `ultimate.uiState()` — durable root-conversation UI state, so you can see what the user is looking at.
- `ultimate.extensions()` — folders, facets, tools, sections, documents, load errors.
- `ultimate.catalogue()` — extension APIs with each one's provider, needs and wants, plus missing providers and dependency cycles.
- `ultimate.trace({ trace?, conversation?, since?, limit? })` — recorded service, action, reactor, tool and model calls (the newest `limit`, default 100 and at most 1000, oldest first) with caller, callee, duration, status and context ids; `ultimate.traceTree(traceId)` nests one trace's calls under their parents.
- `ultimate.apis()` — `[{ name, summary }]` for every enabled extension (built-in, user or project) with an `api.ts` or `refs.ts`: its documented contract, summarised by the first sentence of the opening doc comment of its `api.ts` (else its `refs.ts`). `ultimate.api(name)` returns both files' sources, each under a `// <name>/<file>: …` header line (`api.ts` the server contract, `refs.ts` the documents, actions with their arguments and results, and events), and throws for a name without either. This is progressive discovery: list first, read the one you need. Services in these files are not callable from codemode; act through `ultimate.action`.
- `ultimate.action(extension, action, args?)` — the one write: call an extension action on behalf of this conversation, with the sandbox abort signal; omitted args become null. Returns its JSON result or throws its error. Discover actions with `ultimate.extensions()` and read their args in the extension README.
- `ultimate.conversations()` — all stored conversations with their owner, and for listed ones title, label, cwd,
  busy, inputAt and concluded.
- `ultimate.entries(conversationId, { kinds?, limit?, before?, full? })` — newest-first fork-aware history, including entries before resets/compactions; `before` is an exclusive entry ID. Entries are compact, `{ id, kind, at?, role?, tool?, text?, tools?: { name, args }[], stopReason?, error?, data? }`: message text whole whether stored as a string or blocks, tool results over 1000 characters kept at their start and end (where an exit code is), tool arguments cut to 200 characters and non-`pi.*` `data` to 500 as JSON, no thinking, usage or provider diagnostics (1000 raw entries of a busy conversation were 7.5 MB, its text 30 KB). `stopReason` appears only when it is not `stop` or `toolUse`. `full: true` returns the stored records.
- `ultimate.search(text, { conversationId?, kinds?, limit?, full? })` — case-sensitive substring over stored entry JSON, including pre-reset/pre-compaction history. `kinds` keeps only those entry kinds. Hits are compact, `{ conversation, id, kind, at?, excerpt }` with about 200 characters of the entry's JSON around the match, so wide audits and cross-project reads stay small; `full: true` returns whole entries, or read one hit with `ultimate.entries(conversation, { before: id + 1, limit: 1 })`.
- `ultimate.taskGraph()` — live tasks and ownership graph.

### Other chapters

`conversations`, `entries` and `search` also take `{ chapter: '<name>' }`. Omitted or the active chapter's name reads
live storage as usual; another listed chapter reads its database read-only, without starting tasks. Entries keep the
same compact form (or, with `full`, the same `kind`/`data`/`model` records) and fork-aware order as live history. Closed conversations include their stored
identity/owner and metadata title, label and input time when present, not live activity. Unknown names list the
available chapters. `chapter` and `project` cannot be combined. Cross-chapter links are written `<chapter>#123`.

### Other projects

`conversations`, `entries`, `search`, `trace`, `traceTree` and `doc` take `{ project, machine? }` in their options object (`ultimate.conversations({ project })`, `ultimate.traceTree(id, { project })`, `ultimate.doc('todos', 1, { project })`) and then read that project instead, read-only; `doc` there reads conversation 1 unless one is named, and `machine` picks one machine's instance when the project runs on several. `project` is a name (`my-app`) or a key (`github.com/acme/my-app`), case-insensitive. Only a running instance answers:

- this project reads its own storage;
- another running project on this machine answers over loopback (`ultimate.projects()`'s URL);
- a project the user listed in `remotes` (`{ <machine>: { <project>: url } }` in user settings; see [Discovery and settings](../../docs/settings.md)) answers at the URL set there; a project listed on several machines needs a `machine`;
- otherwise, when cloud backups are on, the cloud's register (`GET /sync/register`, with the cloud token) names the machine that last backed the project up, and the tailnet address it registered (on that backup, else on its machine record) answers.

The call is the target's `codemode.read {op, args}` action, sent with the target's own `Origin`; on the tailnet, Tailscale Serve's identity header and `tailscale.allow` admit it, the same rule as the UI. Nothing falls back to a copy: a machine that registered no tailnet address ("<name> was last backed up from <machine>, which registered no tailnet address") and an unknown name each fail with a sentence that names the machine or lists the known projects. Answers are capped at 1 MiB of JSON (ask for a smaller `limit`). Locating and calling the other instance lives in `lib/remote.ts`, shared with Messages’ Ultimate-to-Ultimate messages.

`ultimate.tell({ project, text, reply?, machine? })` — @ultimate only: message that project's @ultimate, found the same way (`machine` picks one machine's instance when the project runs on several). It returns `{ message, delivered }` (this log's id and the target's); a target that is not running or not reachable fails with a sentence naming the project and machine. With `reply` (default true) the answer returns as a reply. See [Messages](../messages/README.md#other-projects-ultimates).

- `ultimate.models()` — model metadata, without credentials or provider headers.
- `ultimate.agents()` — agent definitions, the profiles subagents and automations run with: each one's source (builtin, user, project), path, fields, and instructions, plus files that failed to parse. To change one, edit its file; for a built-in, write an override with the same name to `<project>/.ultimate/agents/` or `~/.ultimate/agents/`.
- `ultimate.doc(kind, conversationId?, options?)` — exported conversation document or `pi.agent`/`pi.inbox`/`pi.live`/`pi.usage`; defaults to the calling conversation.

Facets can export `userActions: string[]` to reserve actions for the UI. `ultimate.action` rejects these with
`<extension>/<action> is a user-only action`; use the UI for project trust, secret changes, and provider login/logout.
Normal actions remain callable. This dispatch restriction is not a sandbox against arbitrary agent code.

Entry/search limits default to 100 and must be 1–1000. Pagination of raw entries uses the oldest returned entry ID as `before`. Other writes go through normal tools. Action side effects, like nested tool side effects, are not rolled back if the script fails or yields.

## Durable store

`store(key, value)` / `load(key)` use the conversation document `codemode.store` (rewindable, fork as-of). Values are loaded before every script. Store writes are saved only when the script finishes successfully; a yielded wait discards them. The document is exported in `docs` for SSE subscriptions.

**Crash window:** Pi Durable has no result-transaction callback. Store writes use a separate `api.commit()` immediately before returning success. A crash between that commit and durable tool settlement retains the writes while the model may be told the script was **interrupted**. Do not treat store updates as atomic receipts of external side effects.

## Summaries

Every finished or failed codemode call gets one past-tense line saying what it did, such as "Concluded 6 conversations (#190416, #190537, …)" or "Read the conversations extension's contract". `details.calls` lists the `ultimate.*` helper calls next to the `tools.*` calls, so the line can name them; they stream as `✓ ultimate.<name> …` lines too.

- **Fixed labels:** a script with no call, or with one read-only call (an `ultimate.*` read, `read`, `web_search`, `web_fetch`), is labelled from that call without a model (`summary.ts` `fixedLine`), in the call's own commit; failed, it reads "Failed: <error>".
- **Summary model:** any other script starts a background `codemode.summary` task, in its own commit just before the call returns; a call already labelled or still pending (`codemode.summaries-pending`, which a fork starts empty) gets no second one. It asks `summaryModel` (through the conversations service, as messages triage does) with only each call's name, status and arguments, clipped, plus a failure's error, as untrusted data. The script and every result stay home, since the summary model can be another provider and tool output can hold anything; values under secret-looking keys are dropped, and every string is scrubbed before serializing (`scrub`): an allowlist keeps only plain words (names, ids, paths, prose) and replaces anything else (quotes, `=`, braces, a word after `bearer`, known token prefixes, long opaque runs, `user:pass@` URLs) with `[…]`. The answer is `{ line, effect }`: a change (an action that concludes, creates, pauses or configures, a message, a write or edit) leads the line and sets `effect`, also when a later call failed. The task marks the request before sending it and memoizes the response, so a restart never asks twice: a restart between the two gives no line. Its usage is accounted to the conversation. Without a model, or when the answer does not parse, no line is written and the card keeps the script header. A yielded script gets no line.
- **Storage:** the line lives in the conversation document `codemode.summaries` (`{ calls: { [toolCallId]: { line, effect? } } }`, the newest 1000; `api.ts` holds its token) and is recorded as the event `codemode.summarized { conversation, call, line, effect }` in the same commit, which the System surface shows.

## UI

The collapsed header shows the call's summary as plain text, an effect led by an accent ◆, with a quiet `codemode` label and the duration; until a summary exists it shows the script's first line. Its `toolLines` entry gives the same line to the chat's folded runs. `web.tsx` renders each `codemode` call: the script with highlighting (collapsed when long), the nested-call log (✓/✗, tool, arguments, duration; streamed while running, from `details.calls` when done), the text output, images, and the returned value as a JSON tree (`@/components/json-tree`). The Documents tab shows the shown conversation's `codemode.store` under Store, through the renderer `web.tsx` registers for it.
