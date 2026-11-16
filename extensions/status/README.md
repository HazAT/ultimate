One compact, read-only summary of this Ultimate for dashboards that poll several instances: the clone's commit, failed runs, provider health, open questions to the user, how many conversations are busy and which extensions are on or broken. On by default; it does nothing until called.

## Action

`status { since? }` → `Status` (contract in `refs.ts`). `since` is epoch milliseconds and only filters `failures`; it defaults to 24 hours before the call.

```json
{
  "at": 1793112000000,
  "head": {
    "sha": "15af9c1e0d…",
    "branch": "main",
    "behind": 0,
    "ahead": 2,
    "fetchedAt": 1793110000000
  },
  "failures": [
    {
      "conversation": 42,
      "title": "Fix the build",
      "at": 1793101000000,
      "error": "429 rate limited",
      "retried": true
    }
  ],
  "providers": [
    { "provider": "anthropic", "state": "ok" },
    { "provider": "openai-codex", "state": "failing", "error": "invalid_grant" }
  ],
  "questions": {
    "count": 1,
    "first": { "text": "questions 1. Ship it?", "conversation": 57, "message": 812 }
  },
  "busy": 3,
  "extensions": [
    { "name": "status", "source": "builtin", "enabled": true },
    { "name": "cloud", "source": "builtin", "enabled": false },
    { "name": "deploys", "source": "user", "enabled": true, "error": "SyntaxError: …" }
  ]
}
```

Projects can optionally expose progress by adding a read-only `projectProgress` action to any enabled extension. It takes `{}` and returns `{ label: string, index: number, total: number }`, for example `{ "label": "run", "index": 2, "total": 4 }`, or `null` when there is no progress to show. The label must be nonempty, `total` a positive safe integer and `index` a safe integer from 0 through `total`. Status calls providers in registry order (excluding itself), passes the caller's abort signal, and keeps the first valid non-null result as `progress`. Errors and invalid results count as absent. No provider is required.

Each field comes from the API of the extension that owns it, never from its documents:

- `progress`: the optional project progress above; absent when no provider returns a valid result.
- `head`: Update's state from its last check (`UpdateApi.state()`): HEAD of the clone Ultimate runs from, and `behind`/`ahead` against origin as of `fetchedAt`. Origin is fetched in the background at most hourly, never per call. `error` is the last fetch's failure. Absent while Update is off, on a preview, or when Update cannot read the clone (origin has no default branch); the rest of the status still answers.
- `failures`: the failed runs Watchdog reported since `since` (`WatchdogApi.failures()`), newest first. Watchdog keeps the last 20, including @ultimate's own. Absent while Watchdog is off.
- `providers`: Health's providers with a login on this machine (`HealthApi.providers()`), with `state` `ok`, `failing` or `unknown`, and the error of a failing one. Absent while Health is off.
- `questions`: the messages waiting on the user's answer (`MessagesApi.openQuestions()`), `first` the oldest, its text the one line its card shows.
- `busy`: conversations running a turn now.
- `extensions`: every discovered extension from the host's registry (`host.extensions()`), with its `source` (`builtin`, `user` or `project`), whether it is `enabled`, and `error` when its server facet failed to load. A dashboard compares the enabled set with what it expects, and spots a broken extension after a rollout.

Another machine calls it over the tailnet like any action, with an `Origin` header of the instance's own origin: `POST <tailnet url>/api/extensions/status/actions/status` with `{ "args": { "since": 1793025600000 } }` answers `{ "result": Status }`. The caller must be in that instance's `tailscale.allow`. It reads only memory, a small file and two documents, so polling every 30 seconds is cheap; the trace counts repeated calls instead of writing each.
