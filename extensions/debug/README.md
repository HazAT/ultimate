A read-only `debug` tool for finding out why something did or did not happen in the running Ultimate, and for following one chain of work across extensions. It is deferred: only agents whose definition names it get it (@ultimate, in `agents/ultimate.md`).

One tool, one `call` discriminator; every answer is compact text, one line per row, newest first, with relative ages (`40s`, `12m`, `3h`, `2d`) and at most about 16K characters:

- `events { events?, since?, limit? }` — durable events from `host.eventLog.recent`: age, event id, name, data (cut at 160 characters) and the trace context it was emitted in (`trace=… conversation=… call=…`). `events` filters by name (`workspaces.landed`), `since` is an exclusive event id. Default 20.
- `reactors {}` — each reactor with its event names, cursor, lag (matching events after the cursor), `running` or `stopped`, and its last failure with the event it failed on.
- `catalogue {}` — each extension API with its provider (`MISSING` when none), needs and wants, then the missing APIs and dependency cycles.
- `trace { trace?, conversation?, since?, limit? }` — recorded service, action, reactor, tool and model calls (`kind  caller → name  ms  ok|failed: error  args=…`; a `model` row is `agent → <provider>/<model>`) with their trace, conversation and entry ids; `since` is an ISO time. With `trace` set, the whole tree of that trace in start order, children indented under their parents. Default 50, at most 1000. It lists the newest rows only, and its 16K text budget cuts the output at about 160 lines: the trace as a whole is retained for about 7 days (or the newest 200,000 calls, whichever ends first, which dream's `stats` reads), so on a busy project a `trace` query covers the newest hours rather than that window. Narrow by `conversation`, or read older failures in conversation entries and `watchdog.failure` cards.
- `apis {}` — every enabled extension with an `api.ts` or `refs.ts` and the first sentence of its opening doc comment; `api { name }` returns both files' sources, each under a `// <name>/<file>: …` header line. Unknown names fail with the list of known ones.

A typical path: find the event or call that should have led somewhere, take its `trace=` id, and read `trace { trace }`.

The same data is in codemode as `ultimate.catalogue()`, `ultimate.trace()`, `ultimate.traceTree()`, `ultimate.apis()` and `ultimate.api(name)`; both read the contract files through `lib/api-files.ts`.
