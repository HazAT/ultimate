Keeps @ultimate's Claude prompt cache warm while you are away for a while, so your next message reads the whole conversation from the cache instead of writing it again. On by default; the `warm` chip in the status line turns it off.

## Why

Claude Code caches @ultimate's prompt for an hour after each request (`ttl: "1h"` in `@earendil-works/pi-claude-code`). The Anthropic API does too when `PI_CACHE_RETENTION=long` is set; keep-warm never sets it, and it applies to every Anthropic request Ultimate makes. A cache read costs a tenth of the input price, a one-hour cache write twice the input price. After a break of over an hour the next answer writes the whole context again: at ~550k tokens that is ~1.1M input-equivalent, against ~55k for a read. Each request that reads the cache renews its hour (Anthropic: "the cache is refreshed for no additional cost each time the cached content is used").

## How

- A timer outside the task scheduler (a pause holds the scheduler) looks once a minute. A ping is due when @ultimate's last cache request is 55–60 minutes old, @ultimate is idle and runs on `claude-code` (or `anthropic` with long retention), and your latest input to it is under 8 hours old. A cache already past its hour is cold, so no ping is sent to rebuild it.
- The last cache request is @ultimate's newest answer on its current provider and model that came back with cache tokens, or the last successful ping on both. A failed answer or one of another provider or model renewed nothing, so it does not count.
- Your latest input comes from `user.input` events (typed, or an answer to its questions), kept in the state document; until your first input after install, no ping runs.
- Right before sending, after the context is prepared, it checks again: not paused, still on, @ultimate's `LiveDoc` has no run, and the cache is still within its hour. It then records the attempt as `interrupted` and sends; the outcome and its usage are committed together. A crash mid-request therefore counts as a failure.
- The ping replays @ultimate's committed context as its next request would send it (the `You are conversation #N.` identity first, as `conversations` adds it), plus one user line asking for `ok`. The provider reads the prefix up to @ultimate's last input from the cache; that renews it, and @ultimate's next real request reads it again.
- It sends no `sessionId`, so pi-claude-code runs it in a one-shot Claude Code process and @ultimate's own warm process is untouched. Nothing is written to any transcript; the response's usage is added to @ultimate's usage (`accountResponse`), so the status line's spend includes the pings.
- Skips while Ultimate is paused (`PauseApi`, which a rate limit also sets). A failed ping is recorded and blocks further pings until @ultimate's next request, so an outage or a limit is never retried in a loop.
- Not warmed: a system-prompt change (new instructions, sections, tools) still rewrites the cache on the next request. Pings only help idle gaps.

## State and actions

- `keep-warm.state` on conversation 1: `{ off?, last?, pings? }`; `last` is `{ at, provider, model, read?, write?, error? }`.
- `state` → `{ on, lastRequest?, inputAt?, nextAt?, last?, pings }`.
- `set { on }` turns it on or off. User-only: pings spend the user's plan.

## UI

The `warm` chip in the status line: amber while the cache is warm, dimmed while off, red after a failed ping. Its popover has the switch, "Warm until 14:52" or "Cold since …", the next ping or why none is coming, and the last ping's read and write.
