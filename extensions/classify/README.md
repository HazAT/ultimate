Classify provides typed judgments from TypeSafe's Jev System One model to other server facets. It adds no tools, prompt or UI and is off by default (enable it with `secrets`); add `TYPESAFE_API_KEY` in the Secrets panel (⌘K → Secrets). Get a key at https://console.typesafe.ai/keys.

The service pins `jev-1.14.0`; aliases move and confidence thresholds are tuned per version. Input costs approximately $0.042 per million tokens; output is free. State and questions are sent to https://api.typesafe.ai/v1/systemone (or the configured endpoint below): **transcript excerpts sent for classification leave the machine**.

## Endpoint and key

Pi's `typesafe` provider configures both, through `~/.pi/agent/models.json` like any other provider. Its `baseUrl` replaces `https://api.typesafe.ai/v1` (requests go to `<baseUrl>/systemone`), and its key (models.json `apiKey`, with `$ENV` references resolved, `auth.json` or the `TYPESAFE_API_KEY` environment variable) wins over the stored secret. Once it has a key, the setup check no longer reports `TYPESAFE_API_KEY` missing. To go through a proxy:

```json
{
  "providers": {
    "typesafe": { "baseUrl": "https://proxy.example.com/typesafe/v1", "apiKey": "$MY_PROXY_KEY" }
  }
}
```

## Service contract

Import `ClassifyApi` from `api.ts`, then call `host.want(ClassifyApi)` at call time. A disabled provider returns `undefined`.

`ask({ state, questions }, signal)` accepts JSON state and a map of typed questions:

- `choice`: JSON `instructions` and a `criteria` map of option → JSON description (or null). Answers contain `choice`, `confidence` and `probabilities`.
- `noul`: JSON `instructions` and optional `criteria` with `true` / `false` descriptions. Answers contain `noul`, a probability from 0 to 1.
- `score`: JSON `instructions` and an ordered array of JSON level descriptions in `criteria`. Answers contain `score`, `confidence`, `probabilities` and `legend`.

The result is `{ model, answers, usage: { inputTokens } }`; each answer is discriminated by `type`. The exported types are `ClassifyQuestion`, `ClassifyAnswer`, `ClassifyResult` and `ClassifyService`.

Calls forward the supplied abort signal and throw on a missing key, HTTP failure or malformed response envelope / missing or mismatched answer type. There are no retries or caching. Callers are responsible for durable memoization.

A 402 (out of credits), 401 or 403 pauses the service for 15 minutes: every `ask` throws that error again without a request, and a notice names the cause once. A changed key ends the pause at once.
