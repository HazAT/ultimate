Lets scripts and other extensions ask TypeSafe's Jev model quick, inexpensive questions (needs a TypeSafe key). Classify is off by default (enable it with `secrets`); add `TYPESAFE_API_KEY` in the Secrets panel (⌘K → Secrets). Get a key at https://console.typesafe.ai/keys.

The service pins `jev-1.14.0`; aliases move and confidence thresholds are tuned per version. Input costs approximately $0.042 per million tokens; output is free. State and questions are sent to https://api.typesafe.ai/v1/systemone (or the configured endpoint below): **transcript excerpts sent for classification leave the machine**.

## Endpoint and key

Pi's `typesafe` provider configures both, through `~/.pi/agent/models.json` like any other provider. Its `baseUrl` replaces `https://api.typesafe.ai/v1` (requests go to `<baseUrl>/systemone`), and its key (models.json `apiKey`, with `$ENV` references resolved, `auth.json` or the `TYPESAFE_API_KEY` environment variable) wins over the stored secret. Changes to the stored secret take effect on the next request. Once Pi has a key, the setup check no longer reports `TYPESAFE_API_KEY` missing. To go through a proxy:

```json
{
  "providers": {
    "typesafe": { "baseUrl": "https://proxy.example.com/typesafe/v1", "apiKey": "$MY_PROXY_KEY" }
  }
}
```

## Scripts

Call `models.classify({ provider: 'typesafe', id: 'jev-1.14.0' }, { state, questions })` in codemode and branch on the answer's choice or probabilities. The `classify` prompt section, shown to agents with codemode, says so; while no TypeSafe key is set it says instead that Jev isn't set up and to ask the user for `TYPESAFE_API_KEY`. Pi runs up to four model calls at once. Codemode caps a script at 1,000 `models.*` calls, whatever the provider and including after a restart, and ends its result with a usage line (completed calls, input tokens, estimated cost); see `extensions/codemode/README.md`.

A 401 (rejected key), 402 (out of credits) or 403 (forbidden) pauses both script and service calls for that key for 15 minutes. The pause survives a restart: the root conversation's `classify.pause` document keeps `{ keyId, status, until }`, where `keyId` is the first 16 hex characters of the key's SHA-256, never the key or the response body; the paused error is rebuilt from the status. Calls during the pause fail without sending a request. Changing the key lets requests proceed immediately.

## Service contract

Import `ClassifyApi` from `api.ts`, then call `host.want(ClassifyApi)` at call time. A disabled provider returns `undefined`.

`ask({ state, questions }, signal)` accepts JSON state and a map of typed questions:

- `choice`: JSON `instructions` and a `criteria` map of option → JSON description (or null). Answers contain `choice`, `confidence` and `probabilities`.
- `noul`: JSON `instructions` and optional `criteria` with `true` / `false` descriptions. Answers contain `noul`, a probability from 0 to 1.
- `score`: JSON `instructions` and an ordered array of JSON level descriptions in `criteria`. Answers contain `score`, `confidence`, `probabilities` and `legend`.

The result is `{ model, answers, usage: { inputTokens } }`; each answer is discriminated by `type`. The exported types are `ClassifyQuestion`, `ClassifyAnswer`, `ClassifyResult` and `ClassifyService`.

Calls forward the supplied abort signal and throw on a missing key, HTTP failure or malformed response envelope / missing or mismatched answer type. There are no retries or caching. Callers are responsible for durable memoization.
