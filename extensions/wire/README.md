Wire shows what a conversation's model calls actually sent to the provider and what came back: the raw request body, headers without credentials, the response stream and usage, for the last calls of each conversation. Nothing to switch on.

## Where a call comes from

- **Claude Code** (`source: relay`): every request Claude Code sends goes through Pi's turn relay. The patched relay hands each exchange to `claude-code`, which passes it to Wire through `ClaudeCodeExchanges`: the URL, the request headers as sent (`authorization`, `x-api-key`, cookies and anything named like a key, token or secret read `[redacted]`), the exact request body after Pi's rewrite, the response status, headers and raw event stream, and the message the relay assembled from it.
- **Every other provider** (`source: payload`): the generation's `beforeProviderRequest` hook sees the body pi-ai built, after every earlier hook (`fast` adds `service_tier` before it). The reply is the assistant message as Pi assembled it; the transport's own bytes and headers stay inside pi-ai. A Codex WebSocket continuation sends only the input items after the previous response, with `previous_response_id`; Wire notes it on the call (`transport`).

Calls made outside a conversation's generation (titles, summaries, classify, keep-warm pings, compaction summaries) are not kept.

## Storage

One gzipped JSON file per call, `<home>/wire/<conversation>/<n>.json.gz`, outside the durable database. Each conversation keeps its newest 20 calls; the whole folder stays under 300 MB, the oldest calls going first (`store.ts`).
