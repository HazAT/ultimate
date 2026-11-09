## Borrowed from Pi

- `server/http.ts` — adapted HTTP dispatcher, not exported; prevents early provider stream termination. undici in package.json exists only for this file. Drop when Pi exports configureHttpDispatcher and applyHttpProxySettings; keep the MIT notice until then.
- `pnpm-workspace.yaml` — registers patches/@earendil-works__chord@1.5.0.patch, keeping numeric SGR colours that 1.5.0's sanitizeOutput now strips with the other escape sequences, patches/@earendil-works__pi-durable@1.5.0.patch, adding transactional input-placement hooks, marking entries placed from input submissions (input: true) so extensions can distinguish requests from user-role writes, and adding Harness.hold()/release(), which keep the scheduler from starting task runs whatever resume() says (a held invocation parks as pending at its next phase boundary; abort handlers still run), and letting a compaction summary use the model's output limit instead of 0.8 × reserveTokens, as pi-coding-agent has since pi #9512 (`test/compaction-summary.test.ts`), and patches/@earendil-works__pi-claude-code@0.1.0.patch, rebuilding replay cache markers to stay within Claude's four-block limit and wording an incomplete response without stderr ("stream ended without …") so pi-ai's isRetryableAssistantError retries it, accepting the bare-string first user message Claude Code sends when replaying a history that starts with "/", naming the relay's underlying error (class and message) in its failure, and resolving a tool_use named without its MCP prefix (a bare bash for mcp__pi__bash) to Pi's tool instead of ending the turn, leaving a name Pi does not have to its "Tool … is not available" tool result so the model recovers, and parsing a streaming tool call's partial arguments with pi-ai's parseStreamingJson, as pi-ai's own providers do, so tool cards show an edit or write arriving, and defining every later tool by value in a tool_addition block (the inline-tools-2026-09-15 beta, as pi-ai 1.4.0's Anthropic transport does) instead of falling back to one merged system prompt once a tool was redefined: that fallback put every section or tool change at the start of the cached prefix, so each landing rewrote @ultimate's whole cache (17 rewrites, 5.8M tokens in one day), and normalising tool ids from other providers (an OpenAI call_…|fc_… id) to Anthropic's ^[a-zA-Z0-9_-]{1,64}$ with a hash suffix in both tool_use and tool_result frames, since a conversation switched from openai-codex otherwise fails every turn with a 400, and treating a claude auth status that gives no parseable answer (a timeout, a crash, unreadable output) as unknown rather than logged out: the auth check then keeps its last definite answer for that environment instead of hiding every Claude Code model, which once switched @ultimate onto a paid API key while Claude Code was logged in. The pi-claude-code patch also adds useExchangeTap(), which keeps each turn's relayed HTTP exchange (credentials redacted) and hands it to Ultimate after the turn, for Wire. The pi-durable patch also gives NodeExecutionEnv a spawn option and the pi-claude-code patch adds useSpawn(), so bash and Claude Code start their processes from `lib/spawn.ts`'s small helper process instead of forking the large host. The Claude Code patches change only the transcript Pi sends through Claude Code and how its process starts; Claude Code itself is unmodified. Drop each patch when upstream ships the corresponding fix; pnpm errors when a versioned patch no longer matches.
- `test/claude-code-cache.test.ts` — internal imports exercise the pi-claude-code replay cache patch registered in pnpm-workspace.yaml. Drop this coupling and the patch when upstream rebuilds cache breakpoints within Claude's four-block limit.
- `test/claude-code-inline-tools.test.ts` — imports pi-claude-code's patched prepareNativeTranscript. Drop with the patch when upstream defines redefined tools inline.
- `test/claude-code-incomplete.test.ts` — imports pi-claude-code's patched incompleteResponseError and normalizeError and pi-ai's isRetryableAssistantError. Drop with the patch when upstream makes an incomplete response without a reason retryable.
- `test/claude-code-native-tool.test.ts` — imports pi-claude-code's patched piToolName and its TurnRelay. Drop with the patch when upstream accepts a tool_use named without its MCP prefix.
- `test/claude-code-tool-ids.test.ts` — imports pi-claude-code's patched prepareFrames. Drop with the patch when upstream normalises other providers' tool ids.
- `test/claude-code-slash-replay.test.ts` — imports pi-claude-code's patched rewriteInitialRequest and TurnRelay. Drop with the patch when upstream accepts a string first user message on replay and reports the relay error's message.
- `test/claude-code-discovery.test.ts` — drives pi-claude-code's discoverClaudeModels through the patched useSpawn() with a child that exits before its output ends. Drop with the patch when upstream settles childExit() for a child that already exited.
- `test/claude-code-turn-relay.test.ts` — drives pi-claude-code's patched TurnRelay, which retries a request whose connection fails in transport before any response byte (PR #113, anthropics/claude-code#106197). Drop with the patch when upstream retries these failures.
- `lib/compaction.ts` — inlines Pi's unexported createCompaction so a caller's checks and manual compaction creation share one transaction (lineage's tally compaction). Drop when Pi exposes atomic compaction admission.
- `extensions/claude-code/server.ts` — calls the patched useSpawn() of pi-claude-code's claude-cli.ts so Claude Code starts from the process helper. Drop with the patch when upstream accepts a spawn function. It also calls the patched useExchangeTap(), which hands each relayed request (headers with credentials redacted, the exact body) and its raw response to Wire (`extensions/wire`). Drop that part when upstream exposes the relay's exchanges.
- `extensions/lineage/rewind.ts` — copies pi-durable's unexported normalizeToolPath (unicode spaces, a leading @) so going back resolves edit and write paths exactly as those tools do, then resolves them with the exported NodeExecutionEnv.absolutePath (home directory and file URLs). Drop when Pi exports resolveToolPath's normalization.
- `extensions/lineage/catchup.ts` — uses the patched transactional beforeInput hook to place catch-up notes before inputs. Drop the patch when Pi ships input-placement hooks.
- `extensions/messages/server.ts` — uses the same hook to place the line listing an agent's open questions to the user before the input that starts its run.
- `extensions/prompt/server.ts` — uses the same hook to place a "Build changed" note before the input that starts a run, keeping the build out of the cached system prompt.
- `extensions/conversations/server.ts` — uses the same hook to resume a concluded conversation in the commit that places its input.
- `extensions/plan/server.ts` — uses the same hook to empty a new branch's inherited plan in the commit that places its first input.
- `extensions/setup/server.ts` — uses the same hook to place changed setup warnings before the primary agent's input, recording the note and its deduplication state in one commit.
- `extensions/todos/server.ts` — uses the same hook to place a changed to-do list before @ultimate's input, recording the note and its deduplication state in one commit. Drop the coupling when Pi ships input-placement hooks.
- `extensions/models/server.ts` — uses the same hook to switch a conversation whose model lost its login before the run its input starts; the patch also routes a failed run's afterFailedRun "continue" boundary through it.
- `extensions/goal/server.ts` — uses the patched transactional beforeInput hook to place an open hands-off goal's note before @ultimate's input. Drop the coupling when Pi ships input-placement hooks.
- `extensions/pause/server.ts` — uses the patched Harness.hold()/release() for the user's soft pause. Drop the patch when Pi Durable ships a scheduler hold.
- `extensions/dream/server.ts` — uses the patched Harness.hold() after approving a chapter switch so no new tasks start before the replacement core takes over. Drop the coupling when Pi Durable ships a scheduler hold.
- `extensions/coding-tools/diff.tsx` — internal untyped details.patch/details.diff formats drive the diff renderer. Drop when Pi exports structured diff rows for rendering.
- `extensions/prompt/server.ts` — tool guidance adapted from unexported prompt contributions, not Ultimate's personality. Drop when Pi exports buildSystemPromptSections and the per-tool system prompt contributions.
- `web/src/app/model.ts` — internal trailing <harness> text block duplicates diagnostics and is stripped for display. Drop when Pi exports a diagnostic-free tool-result content accessor.
- `web/src/sdk/format.ts` — copied formatTokens helper, not exported. Drop when Pi exports formatTokens.
- `web/src/sdk/events.ts` — adapted Pi event bus using browser-safe sets instead of node:events, with Pi's exported EventBus type and handler-error semantics. Drop when Pi ships a browser-safe bus.
- `extensions/coding-tools/web.tsx` — internal bash exit_code diagnostic message drives exitOf and untyped details.patch/details.diff drive Edit. Drop when Pi exports structured bash outcomes and structured diff rows for rendering.
- `extensions/context/breakdown.ts` — internal remove-all pi.system entry immediately precedes a reordered re-add, folded into the re-add's diff here. Drop when Pi exposes prompt reorder metadata instead of requiring entry-sequence inference.
- `extensions/fast/server.ts` — sets service_tier through onPayload because pi-ai's simple stream options drop serviceTier. Drop when buildBaseOptions forwards serviceTier and Pi Durable stream settings accept it.
- `server/tool-arguments.ts` — ends degenerate tool-call argument streams with an error worded to match pi-ai's retryable error pattern, so the generation retries it. Drop the wording when Pi Durable lets a stream mark its error retryable.
- `lib/chapters.ts` — raises a new chapter's durable_metadata.next_id so record ids continue across chapters, and reads a closed chapter's live foreground tasks from the tasks table to refuse a switch into it. Drop when Pi Durable takes a first record id when it creates storage and reads a closed store's task graph.
- `extensions/codemode/chapters.ts` — reads closed chapters' conversation and entry JSON records, follows fork cutoffs, and replays metadata document revisions with read-only SQL. Drop when Pi's SQLite storage opens over a read-only connection: 1.5.0's `HarnessOptions.readOnly` still writes the file (WAL mode, migrations, a checkpoint on close).
- `.ultimate/skills/measure-switch/copy-paused.ts` — writes a pause.state delta into a scratch database's document_revisions and advances durable_metadata.next_seq, relying on Pi Durable's SQLite schema and chord operation format. Drop when Pi exposes an offline document-update API.
- `extensions/subagents/server.ts` — internal ToolTaskInput.assistant locates the calling assistant for history forks. Drop when ToolExecutionApi exposes the calling assistant entry ID.
- `server/skills.ts` — copies AgentSession's unexported _expandSkillCommand block format for /skill:name invocation. Drop when Pi exports the skill command expansion.

On a Pi upgrade, run `rg "Pi upstream:"` and recheck each marked item against the new version; `scripts/pi-upstream.ts` (part of `pnpm check`) checks that every tracked marker matches the installed package version and its path appears in this list, and the backticked path each entry starts with is tracked and contains a marker; backticks later in an entry are prose.
Delete copies and patches that Pi now exports or fixes, then update the remaining markers and this list after verification.

## Searching Pi's code

The Pi packages live under `node_modules/@earendil-works/<pkg>` (pnpm symlinks). Only pi-claude-code ships its TypeScript
source; the others ship type declarations and compiled JS, so start in the `.d.ts` files, whose doc comments carry the
contracts.

| Package           | Types and compiled JS          | Also                                 |
| ----------------- | ------------------------------ | ------------------------------------ |
| `pi-durable`      | `dist/*.d.ts`, `dist/*.js`     | `README.md`, `CHANGELOG.md`          |
| `pi-ai`           | `dist/*.d.ts`, `dist/*.js`     | `README.md`                          |
| `pi-coding-agent` | `dist/*.d.ts`, `dist/*.js`     | `README.md`, `docs/`, `examples/`    |
| `pi-claude-code`  | none: `src/*.ts` is the source | `README.md`, `ARCHITECTURE.md`       |
| `chord`           | `dist/*.d.ts`, `dist/*.js`     | `README.md`, `docs/`, `CHANGELOG.md` |
| `pi-schema`       | `dist/*.d.ts`, `dist/*.js`     | `README.md`, `CHANGELOG.md`          |
| `pi-codemode`     | `dist/*.d.ts`, `dist/*.js`     | `README.md`                          |
| `pi-mcp`          | `dist/*.d.ts`, `dist/*.js`     | `README.md`, `CHANGELOG.md`          |

A search from the repository root skips them, because `node_modules` is gitignored and its entries are symlinks. Follow
symlinks, override the ignore files, and skip nested dependencies and source maps:

```bash
rg -L --no-ignore -g '!node_modules' -g '!*.map' -n '<term>' node_modules/@earendil-works
```

Narrow it to one package with `node_modules/@earendil-works/<pkg>`.

## Reference

- Pi Durable README and examples: `node_modules/@earendil-works/pi-durable/README.md`, upstream
  https://github.com/earendil-works/pi/tree/main/packages/durable
- The durable coding agent this host follows: https://github.com/earendil-works/pi/tree/main/packages/coding-agent/src/experimental/durable
