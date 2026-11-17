# Introspection: tracing and inspecting yourself

Part of the [extension guide](../../extensions/README.md).

## Tracing

`server/trace.ts` records every service call (`<caller extension>` → `<api>.<method>`), extension action
(`ui` or `agent` → `<extension>/<action>`), reactor run (event name → `<extension>/<reactor>`) and tool execution
(`agent`, or the calling tool's extension for a tool another running tool calls, as a Pi nested call or directly
like codemode's `tools.*` → tool name) with its duration, `ok` and error message.
Each runs in a trace context (AsyncLocalStorage, which survives Pi Durable commits and its task runner) of
`{ traceId, conversationId?, taskId?, entryId?, parentCall? }`: a call is the parent of the calls it makes, a tool
call carries its conversation, task and the assistant entry holding the call, and `host.emit` stamps the context on
the event so its reactors continue the emitter's trace. Nothing to do in an extension: `implement`, actions,
`react` and tools are traced for you.

Every model stream is a `model` row too (`agent` for Pi's generations and compactions, `extension` for an
extension's own call → `<provider>/<model>`): its duration, input, output and cache tokens and stop reason, never the
prompt or the response; an error or aborted stop is a failed row whose error is only a classification (stop reason,
HTTP status and allowlisted error codes), since a provider message can echo the request. `completeSimple` (health's
pings) goes through the same wrapper, as does the `modelRuntime` extensions call directly. Pi runs requests outside any traced call but sends
the conversation's provider session id, so a `beforeRequest` hook (`model-trace`, `server/tool-arguments.ts`) maps
session ids to conversations; a request before its conversation's first generation in this process (a compaction just
after a restart) stays unlinked, and an extension's call belongs to the call it runs in.

UI polls would otherwise fill the trace: a successful action or service call that starts its trace and repeats one
written within the last minute (same name, same argument summary), or an action an extension lists in `pollActions`,
is not written, nor the plain action and service calls it makes; it is counted instead, and `host.trace.polls()`
lists the counts since the trace opened (`{ name, count, since }`, most first). Failures, model, tool and sealed calls
are always written, and one written under a poll writes the chain above it too, so its tree stays whole. A poll that
emits a durable event is written as well (`emit` calls the trace's `keep`): its reactors run later under the event's
copy of its context and need it as their parent. Marks are kept by call id, so such copies match. On this host
it cuts writes by ~89 %.

Arguments and results are stored as JSON summaries of about 300 characters with values under keys matching
`/secret|token|password|key|auth/i` replaced by `[redacted]`; tool calls keep none (the transcript has them). Calls
into the extensions that handle credentials, `secrets` (secret values) and `models` (API keys and OAuth codes
answering a login), keep neither, nor an error message, only the error's class. A new extension whose actions or
services take or return credentials joins `SEALED` in `server/trace.ts`. Rows go to `<home>/trace.sqlite` in batches outside Pi commits, while
the harness is open only; retention keeps 7 days and at most 200,000 rows. A trace failure is logged once and never
fails the call. Read with `host.trace.query({ trace?, conversation?, since?, limit })` (the newest `limit`, oldest
first), `host.trace.page({ before?, after?, since?, until?, kinds?, conversation?, errors?, text?, limit })` (calls by write
position `seq`, which is finish order, for paging; the `system` extension's stream uses it),
`host.trace.tree(traceId)` (calls nested under `children`) and `host.trace.polls()`, or codemode's
`ultimate.trace(...)` and `ultimate.traceTree(traceId)`. The `system` extension merges the trace and the event log
into one paged stream (`extensions/system/README.md`).

## Inspecting yourself

Use `codemode` to compose dependent or parallel `tools.*` calls and filter results before they enter your context. Its `ultimate.*` API is the way to inspect yourself: system/build, extension facets and load errors, conversations, stored entries and search (including before compactions/resets), the extension API catalogue, the extension contracts (`ultimate.apis()` lists them, `ultimate.api(name)` returns an extension's `api.ts` and `refs.ts`), the call trace, task graph, models, and exported documents. @ultimate has the same reads as its `debug` tool (`extensions/debug/README.md`). `ultimate.action(extension, action, args?)` is its one write: call an extension action on behalf of this conversation. Use ordinary tools for other writes and single simple calls. `store`/`load` persist conversation-scoped values; see `extensions/codemode/README.md` for interruption semantics.
