Codemode is Pi Durable's code mode tool (`createCodemodeExtension` from `@earendil-works/pi-durable/codemode`): the model writes an async JavaScript function body that runs in a QuickJS/WASM sandbox, and only injected functions reach the host. Prefer it for dependent or parallel tool calls, filtering large outputs, many small judgments with a classifier, and inspecting Ultimate; use ordinary tools for a single simple operation.

`await tools.<name>(args)` calls the conversation's callable tools (those whose `callers` include `tools`) through `api.executeTool()`: each nested call is its own `pi.tool` task owned by the script's call, runs the `beforeTool`/`afterTool` hooks (a block rejects the call), streams into `pi.live.nestedTools`, and keeps its result out of the transcript. A tool declaring `structuredOutputSchema` resolves to its `structuredOutput`, also on an error result that carries one: `tools.bash` resolves to `{ output, truncated, exitCode, fullOutputPath? }` and a nonzero exit does not reject, so check `exitCode`. Other tools resolve to their text output. Pi's tool description lists the script globals (`text`, `image`, `console`, `store`/`load`, `searchTools`, `models.*`); the `codemode` prompt section lists the tools scripts can call.

**Journaled replay.** The tool is `replay: 'safe'`: Pi journals every nested call's and global's result, and a script a restart interrupts runs again from its start data, gets the recorded results in the same order and continues live, so finished calls (a bash command, a paid classify call) never run twice. A script that takes another path on the rerun fails instead. Tools that must never run twice are `replay: 'unsafe'`: an interrupted one fails rather than running again.

**Script-only tools.** `action` and `tell` have `callers: ['tools']`, so only scripts call them, and `replay: 'unsafe'`. `restart` has `callers: ['model']`, so scripts never see it. `lib/agents.ts` `definitionAgent` keeps the parent's script-only tools in a definition's tool list when the definition has codemode, so subagents and standing agents get them. A conversation whose exact tool list was stored before this (an older subagent, or a fork of its history) has no script-only tools: its scripts get `tools.action does not exist` until the agent is started again.

**Subagents in scripts.** A nested `subagent` start or message always runs in the background (subagents' `beforeTool` hook sets `background: true`), so its answer arrives as a normal report; a nested `wait` or `background: false` is refused with "wait at top level".

**Models.** `models: true` gives scripts Pi's `models.*`: the catalog, `models.classify(model, {state, questions})` and `models.generateImages()`, at most 4 at once. `models.ts` caps a script at 1,000 `pi.codemode.models.*` calls of any provider (admissions counted durably per script, so the cap holds across a restart), records each completed call's input tokens and cost from its own afterTool hook, and appends a usage line summed from those records (it never opens the nested results, which can hold images) to the script's result: `models: <calls>, <input tokens>, ≈$<cost from Pi's usage>`. The TypeSafe key, the pinned Jev model, its prompt section and the billing pause live in `extensions/classify`.

Final details are Pi's `CodemodeToolDetails`: `{ calls: [{ id, name, args, status, durationMs?, error? }], fullOutputPath? }`, the tool calls in call order (globals are not listed). The first line may be `// @options: {"timeout_ms":30000,"max_output_tokens":2000}`. A script without `timeout_ms` gets 60 seconds: a `beforeTool` hook adds it to the options line, so the deadline is recorded with the call and a resumed script keeps it.

## Introspection and actions

Only inside codemode (not standalone model tools):

- `ultimate.system()` — machine, process, persistence, resources, build identity.
- `ultimate.projects()` — project folders, their top-level conversation summaries, and URL when running (JSON manifests only, not other stores' SQLite).
- `ultimate.uiState()` — durable root-conversation UI state, so you can see what the user is looking at.
- `ultimate.extensions()` — folders, facets, tools, sections, documents, load errors.
- `ultimate.catalogue()` — extension APIs with each one's provider, needs and wants, plus missing providers and dependency cycles.
- `ultimate.trace({ trace?, conversation?, since?, until?, limit? })` — recorded service, action, reactor, tool and model calls, oldest first (default `limit` 100 and at most 1000), with caller, callee, duration, status and context ids: with `since`, reads the oldest `limit` calls after `since` (up to `until`), otherwise the newest `limit` calls (before `until`); `ultimate.traceTree(traceId)` nests one trace's calls under their parents.
- `ultimate.apis()` — `[{ name, summary }]` for every enabled extension (built-in, user or project) with an `api.ts` or `refs.ts`: its documented contract, summarised by the first sentence of the opening doc comment of its `api.ts` (else its `refs.ts`). `ultimate.api(name)` returns both files' sources, each under a `// <name>/<file>: …` header line (`api.ts` the server contract, `refs.ts` the documents, actions with their arguments and results, and events), and throws for a name without either. This is progressive discovery: list first, read the one you need. Services in these files are not callable from codemode; act through `tools.action`.
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

`tools.tell({ project, text, reply?, machine? })` (scripts only, @ultimate only): message that project's @ultimate, found the same way (`machine` picks one machine's instance when the project runs on several). It returns `{ message, delivered }` (this log's id and the target's); a target that is not running or not reachable fails with a sentence naming the project and machine. With `reply` (default true) the answer returns as a reply. See [Messages](../messages/README.md#other-projects-ultimates).

- `ultimate.models()` — model metadata, without credentials or provider headers.
- `ultimate.agents()` — agent definitions, the profiles subagents and automations run with: each one's source (builtin, user, project), path, fields, and instructions, plus files that failed to parse. To change one, edit its file; for a built-in, write an override with the same name to `<project>/.ultimate/agents/` or `~/.ultimate/agents/`.
- `ultimate.doc(kind, conversationId?, options?)` — exported conversation document or `pi.agent`/`pi.inbox`/`pi.live`/`pi.usage`; defaults to the calling conversation.

`tools.action({ extension, action, args? })` (scripts only) is the one write: call an extension action on behalf of this conversation; omitted args become null. It resolves to the action's JSON result or rejects with its error. Discover actions with `ultimate.extensions()` and `ultimate.api(name)`.

Facets can export `userActions: string[]` to reserve actions for the UI. `tools.action` rejects these with
`<extension>/<action> is a user-only action`; use the UI for project trust, secret changes, and provider login/logout.
Normal actions remain callable. This dispatch restriction is not a sandbox against arbitrary agent code.

Entry/search limits default to 100; a limit outside 1–1000 is clamped into it, as `trace`'s is. Pagination of raw entries uses the oldest returned entry ID as `before`. Other writes go through normal tools. Action side effects, like nested tool side effects, are not rolled back if the script fails.

## Durable store

`store(key, value)` / `load(key)` use Pi's conversation document `pi.codemode.store` (`{ values }`, rewindable, fork as-of). A script sees the values as they were when it started; its writes commit with its result, in the same transaction, and only when it completes. Values from the retired `codemode.store` are copied into it once per conversation, on its first codemode call after the upgrade, without replacing a key the new store already has. The marker `codemode.store-copied` is a rewindable conversation document forked as of the fork point, written in the same commit, so a fork or rewind sees the same copy and a key deleted after the copy stays deleted.

## Summaries

Every finished or failed codemode call gets one past-tense line saying what it did, such as "Concluded 6 conversations (#190416, #190537, …)" or "Read the conversations extension's contract". An `afterTool` hook on the top-level `codemode` call builds the line from Pi's `details.calls` plus the `ultimate.*` helper calls the script made, which each global records in memory for its codemode task (a call resumed after a restart has none and gets the neutral line "Ran a script"); a failed script reaches the summary model only as the fixed reason "Script failed", never its output.

- **Fixed labels:** a script with no call, or with one read-only call (an `ultimate.*` read, `read`, `web_search`, `web_fetch`), is labelled from that call without a model (`summary.ts` `fixedLine`), in the call's own commit; failed, it reads "Failed: <error>".
- **Summary model:** any other script starts a background `codemode.summary` task, in its own commit just before the call returns; a call already labelled or still pending (`codemode.summaries-pending`, which a fork starts empty) gets no second one. It asks `summaryModel` (through the conversations service, as messages triage does) with only each call's name, status and arguments, clipped, plus a failure's error, as untrusted data. The script and every result stay home, since the summary model can be another provider and tool output can hold anything; values under secret-looking keys are dropped, and every string is scrubbed before serializing (`scrub`): an allowlist keeps only plain words (names, ids, paths, prose) and replaces anything else (quotes, `=`, braces, a word after `bearer`, known token prefixes, long opaque runs, `user:pass@` URLs) with `[…]`. The answer is `{ line, effect }`: a change (an action that concludes, creates, pauses or configures, a message, a write or edit) leads the line and sets `effect`, also when a later call failed. The task marks the request before sending it and memoizes the response, so a restart never asks twice: a restart between the two gives no line. Its usage is accounted to the conversation. Without a model, or when the answer does not parse, no line is written and the card keeps the script header.
- **Storage:** the line lives in the conversation document `codemode.summaries` (`{ calls: { [toolCallId]: { line, effect? } } }`, the newest 1000; `api.ts` holds its token) and is recorded as the event `codemode.summarized { conversation, call, line, effect }` in the same commit, which the System surface shows.

## UI

The collapsed header shows the call's summary as plain text, an effect led by an accent ◆, with a quiet `codemode` label and the duration; until a summary exists it shows the script's first line. Its `toolLines` entry gives the same line to the chat's folded runs. `call.solid.tsx` renders each `codemode` call: the script with highlighting (collapsed when long), the nested-call log (✓/✗, tool, arguments, duration; from `pi.live.nestedTools` while running, from `details.calls` when done), the text output and images. The Documents tab shows the shown conversation's `pi.codemode.store` under Store, through the renderer `web.solid.tsx` registers for it.
