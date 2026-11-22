Keeps @ultimate's Claude prompt cache warm while you are away for a while, so your next message reads the whole conversation from the cache instead of writing it again. On by default; the `warm` chip in the status line turns it off.

## Why

Claude Code caches @ultimate's prompt for an hour after each request (`ttl: "1h"` in `@earendil-works/pi-claude-code`). The Anthropic API does too when `PI_CACHE_RETENTION=long` is set; keep-warm never sets it, and it applies to every Anthropic request Ultimate makes. A cache read costs a tenth of the input price, a one-hour cache write twice the input price. After a break of over an hour the next answer writes the whole context again: at ~550k tokens that is ~1.1M input-equivalent, against ~55k for a read. Each request that reads the cache renews its hour (Anthropic: "the cache is refreshed for no additional cost each time the cached content is used").

## How

- A `keep-warm.ping` task on conversation 1 sleeps until the ping is due; each @ultimate response that read or wrote its cache records itself and starts the task when none is live (the doc's `waker`). A ping is due 55 minutes after @ultimate's last cache request, when it runs on `claude-code` (or `anthropic` with long retention) and your latest input to it is under 8 hours old. Woken early (a newer request moved the time), it sleeps again; while @ultimate runs, it waits for the run; with nothing due, it ends. A cache already past its hour is cold, so no ping is sent to rebuild it.
- The last cache request is the newest response in @ultimate's current conversation that came back with cache tokens on its current provider and model, read from its transcript on open and whenever such an answer or a change to its agent commits (so it works whichever extensions @ultimate's agent lists), or the last successful ping on all three. A new @ultimate conversation inherits nothing. Your input, a cached answer, `set {on}` and a model change start a waker when none sleeps until the time that is now due. A failed answer or one of another provider or model renewed nothing, so it does not count.
- Your latest input comes from `user.input` events (typed, or an answer to its questions), kept in the state document; until your first input after install, no ping runs.
- It prepares the context first, then records the attempt as `interrupted` in the commit that checks it is still on, still due, not paused and @ultimate's `LiveDoc` has no run; right before sending it checks the pause and the hour once more. The outcome and its usage are committed together. A crash mid-request counts as a failure: the task plans again and sends nothing more until a newer request.
- The ping replays @ultimate's committed context as its next request would send it (the `You are conversation #N.` identity right after the leading system message, as `conversations` adds it), plus one user line asking for `ok`. The provider reads the prefix up to @ultimate's last input from the cache; that renews it, and @ultimate's next real request reads it again.
- It sends no `sessionId`, so pi-claude-code runs it in a one-shot Claude Code process and @ultimate's own warm process is untouched. Nothing is written to any transcript; the response's usage is added to @ultimate's usage (`accountResponse`), so the status line's spend includes the pings.
- Sends nothing while Ultimate is paused (`PauseApi`, which a rate limit also sets): the pause holds the task scheduler, so the sleeping task does not wake. A failed ping is recorded and blocks further pings until @ultimate's next request, so an outage or a limit is never retried in a loop.
- Not warmed: a system-prompt change (new instructions, sections, tools) still rewrites the cache on the next request. Pings only help idle gaps.

## State and actions

- `keep-warm.state` on conversation 1: `{ off?, inputAt?, answers?, last?, pings?, waker? }` (`answers` maps `provider/model` to ms); `last` is `{ at, provider, model, read?, write?, error? }`.
- `state` → `{ on, lastRequest?, inputAt?, nextAt?, last?, pings }`.
- `set { on }` turns it on or off. User-only: pings spend the user's plan.

## UI

The `warm` chip in the status line: amber while the cache is warm, dimmed while off, red after a failed ping. Its popover has the switch, "Warm until 14:52" or "Cold since …", the next ping or why none is coming, and the last ping's read and write.
