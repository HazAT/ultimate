Keeps the prompt cache of standing agents (@ultimate) and branch coordinators warm while they wait, and can compact a branch before its cache runs cold, so the next turn does not write the whole context again. How long each is kept warm is part of its agent definition (`cache:`), edited in the Agents panel; the status line's `@ultimate` chip (always) and `branch` chip (on an open coordinator) show the state and override it for that one conversation. Earlier it warmed only @ultimate, and only on hour-long caches; a switch turned off that way carries over as @ultimate's `warm: false`.

## Why

A cache read costs a tenth of the input price; once the cache expires, the next turn writes the whole context again: 1.25 times the input price after a five-minute cache, twice after a one-hour one. @ultimate waits on the user for hours; a branch waits on the user, a subagent, the lander or a long command.

Measured on GitHub Copilot (November 2026): Claude Opus 5.5 keeps the cache for 5 minutes. A 240k context costs $1.20 to write again and $0.05 to ping; over 20 days of coordinators, pinging for 30 minutes after the last request cut the cache cost from $129 to $70. Pinging a five-minute cache breaks even at about 100 minutes of pause, so long windows cap at `shortMinutes` there.

## Policy

An agent definition's `cache` mapping, all optional, layered like every definition field (built-in → user → project; an overlay changes only the keys it names):

```yaml
cache: { warm: true, minutes: 480, shortMinutes: 90, compact: false, compactTokens: 150000 }
```

- `warm`: keep it warm while idle (default off).
- `minutes`: how long after its window starts (default 30). A standing agent's window starts at the user's last input to it, a coordinator's at its last request.
- `shortMinutes`: `minutes` on a model whose cache lives under an hour (default `minutes`).
- `compact`, `compactTokens`: compact before cold once the context has at least that many tokens (default off, 150000). Branch coordinators only: a standing agent's dreams compact it, so `compact` is ignored there and its chip and Agents form leave it out.

Built-in: `ultimate` warms 480 min (90 on a five-minute cache), `coordinator` 30 min. Only standing agents and open branch coordinators (top-level, label `coordinator`) are warmed; subagents are short-lived. `keepWarm.maxWarm` in settings (default 5) limits how many branches are kept warm at once, the most recent first; standing agents do not count.

A conversation's own overrides of `warm`, `compact` and `minutes` (the chip's popover) win over its definition; the popover marks an override `this chat`, with a reset back to the definition; unmarked values are the definition's or the default.

## How

It follows pi's own cache warmer (`CacheWarmer` in pi-coding-agent, policy in pi-ai's `cache-warming`), which Pi Durable does not run:

- **Cache lifetime** comes from the model's `promptCache` metadata, as pi-ai's `getPromptCacheTtlMs` reads it (`long` under `PI_CACHE_RETENTION=long`, else `short`). Claude Code models, whose catalog has none, always write one-hour caches. A model without a known lifetime is not warmed. Models that pi-ai does not describe, such as Claude on Copilot, get one through `modelOverrides` in pi's `~/.pi/agent/models.json`:

  ```json
  {
    "providers": {
      "github-copilot": {
        "modelOverrides": {
          "claude-opus-5.5": { "promptCache": { "short": 300, "long": 3600 } }
        }
      }
    }
  }
  ```

- **Each answer starts a warming run** from the request that wrote the cache. A timer fires at 90 % of the lifetime after the last request on the cache (pi-ai's `getCacheWarmingDelayMs`: 4.5 minutes on a five-minute cache, 54 on an hour), and again after each ping. A timer that fires after half the remaining margin is skipped: a late refresh writes the cache at full price. A new answer, a compaction or a model switch ends the run.
- **A ping re-sends the last real request** as the provider received it (captured by `beforeProviderRequest`), with its output capped at one token and no retries (`getCacheWarmingRequestOptions`): it reads the whole cache and writes nothing. The cap is set in the body itself, so replay covers the Anthropic Messages API (`max_tokens`); a captured body of another API is not warmed. Models whose requests cannot be replayed unchanged (budget-based thinking, `isCacheWarmingReplayable`) are not warmed. Claude Code requests are not visible to that hook, so their ping is the conversation's next context (identity after the leading system message) plus one `ok` line, sent without a session. Usage counts on the conversation; nothing goes in the transcript. A failed ping ends the run.
- **How long:** while it has a run, at least an hour after its request (pi's `CACHE_WARMING_MAX_AGE_MS`); when idle, its window above.
- **Compact before cold** starts a manual compaction when an idle conversation's window is over, its context has at least `compactTokens`, and it was not compacted since its last request. Its summary reads the cache: this extension's `beforeCompact` hook (ordered before lineage's) sends the next context plus a request for the summary; if that fails, lineage's summarizer writes it. The summary is memoised, and the compaction's admission commits with its record, so a restart neither repeats it nor starts a second one.
- Warming runs live in the process: a restart or a reload of this extension ends them, and each conversation's next answer starts a new one. Nothing happens while Ultimate is paused.

## State and actions

- `keep-warm.state` on each warmed conversation: `{ warm?, compact?, minutes?, inputAt?, last?, pings?, compaction? }`.
- `state { id }` → kind (`standing` or `coordinator`), agent, each value with its source, the model with its cache lifetime and ping time, the last request on the cache, context size, the next step or why none, the last ping and compaction.
- `set { id, warm?, compact?, minutes? }` (`null` removes an override), user-only: pings and summaries spend the user's plan. Each change is recorded as `ui.changed` (`keep-warm.warm`, `.compact`, `.minutes`).
