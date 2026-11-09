Wire shows what a conversation's model calls actually sent to the provider and what came back: the raw request body, headers without credentials, the response stream and usage, for the last calls of each conversation. Nothing to switch on. It is a tab of the System surface; disabling this extension removes the tab, the transcript links and the capture.

## In the UI

- **The Wire tab** of the System surface (the `system.tab` point; ⌘K Open Wire) shows the shown conversation's kept calls, newest first, with cache read and write per call, and the selected call beside them, the agent docked on the right. **Request** and **Response** have a **Readable** view (structure first: the cache breakpoints, headers, then the prefix in cache order and the settings; everything folds to one line with its size, and `cache_control` markers sit where they are sent) and a **Raw** one (the body pretty-printed, the stream as received). **Diff** compares the request with the call before it in cache order (`diff.ts`): a pure append is the cache working; a break shows the segment and the characters on both sides of it.
- **From the transcript**: hovering a response shows `wire #n ›` on its header line, opening Wire at the call behind it (by `responseId`, else the call that started within a minute of it). On a response that rebuilt the cache it stays visible, in the warning tone.

## Where a call comes from

- **Claude Code** (`source: relay`): every request Claude Code sends goes through Pi's turn relay. The patched relay hands each exchange to `claude-code`, which passes it to Wire through `ClaudeCodeExchanges`: the URL, the request headers as sent (`authorization`, `x-api-key`, cookies and anything named like a key, token or secret read `[redacted]`), the exact request body after Pi's rewrite, the response status, headers and raw event stream, and the message the relay assembled from it.
- **Every other provider** (`source: payload`): the generation's `beforeProviderRequest` hook sees the body pi-ai built, after every earlier hook (`fast` adds `service_tier` before it). The reply is the assistant message as Pi assembled it; the transport's own bytes and headers stay inside pi-ai. A Codex WebSocket continuation sends only the input items after the previous response, with `previous_response_id`; Wire notes it on the call (`transport`).

Calls made outside a conversation's generation (titles, summaries, classify, keep-warm pings, compaction summaries) are not kept.

## Storage

One gzipped JSON file per call, `<home>/wire/<conversation>/<n>.json.gz`, outside the durable database. Each conversation keeps its newest 20 calls; the whole folder stays under 300 MB, the oldest calls going first (`store.ts`).
