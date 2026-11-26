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

- **A sleeping task keeps the schedule.** Each answer records its request (`request`: when it was sent, on which model, and whether it touched the cache) and starts a `keep-warm.ping` task on that conversation when none sleeps until the time now due (its `waker`). The task sleeps until 90 % of the lifetime after the last request on the cache (pi-ai's `getCacheWarmingDelayMs`: 4.5 minutes on a five-minute cache, 54 on an hour), plans, pings, and sleeps again; with nothing due it ends. Woken early or late, it plans from the stored request and ping again: a refresh that came after half the remaining margin is skipped, since a late refresh writes the cache at full price. It is a durable task, so it survives a restart, shows in the task graph, and a pause holds it (the pause holds the task scheduler) until the pause lifts. On open, keep-warm reads each warmed conversation's newest answer it missed and arms a waker for it.
- **Idle, the ping is the transcript plus `ok`:** the conversation's committed context as its next request would send it (the `You are conversation #N.` identity after the leading system message) and one user line asking for `ok`, sent without a session, so Claude Code runs it in a one-shot process. The provider reads the prefix up to the last request from the cache, which renews it. It works on every provider, needs nothing in memory, and costs a few output tokens.
- **During a run, the ping replays the request in flight.** While a tool call runs, the transcript ends in an unanswered tool call, which no provider accepts. So `beforeProviderRequest` keeps the last request body each conversation sent, in memory only, and the ping re-sends it with its output capped at one token and no retries (`getCacheWarmingRequestOptions`): it reads the whole cache and writes nothing. The cap is set in the body itself, so replay covers the Anthropic Messages API (`max_tokens`); models whose requests cannot be replayed unchanged (budget-based thinking, `isCacheWarmingReplayable`) and Claude Code, whose requests that hook does not see, wait for the run to end instead. The body is the whole context and is never written to storage; after a restart the in-flight replay is gone and the run waits. It matters on five-minute caches, where a test suite or a build outlasts the cache.
- **No double ping.** A real request counts as a refresh from the moment it is sent: the task plans from the newest of the last answer, the last ping and the request in flight, so a tool call that ends and sends its next request just before the ping is due pushes the ping back by a full delay.
- Usage counts on the conversation; nothing goes in the transcript. Before sending, the attempt is recorded as `interrupted` in the commit that checks the waker is still the one, still due and not paused; a crash mid-request counts as a failure. A failed ping stops warming until the next real request, so an outage or a limit is never retried in a loop.
- **How long:** while it has a run, at least an hour after its request (pi's `CACHE_WARMING_MAX_AGE_MS`); when idle, its window above.
- **Compact before cold** starts a manual compaction when an idle conversation's window is over, its context has at least `compactTokens`, and it was not compacted since its last request. Its summary reads the cache: this extension's `beforeCompact` hook (ordered before lineage's) sends the next context plus a request for the summary; if that fails, lineage's summarizer writes it. The summary is memoised, and the compaction's admission commits with its record, so a restart neither repeats it nor starts a second one.

## State and actions

- `keep-warm.state` on each warmed conversation: `{ warm?, compact?, minutes?, inputAt?, request?, waker?, last?, pings?, streak?, compaction? }`.
- `state { id }` → kind (`standing` or `coordinator`), agent, each value with its source, the model with its cache lifetime and ping time, the last request on the cache, context size, the next step or why none, the last ping and compaction.
- `set { id, warm?, compact?, minutes? }` (`null` removes an override), user-only: pings and summaries spend the user's plan. Each change is recorded as `ui.changed` (`keep-warm.warm`, `.compact`, `.minutes`).
