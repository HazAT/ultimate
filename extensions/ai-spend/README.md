A **Spend** tab in the top bar: what this project's model calls cost, by conversation, agent, model, tool and time, with a forecast for the week and month.

It only reads the store. Its one write is its own history file.

## What it shows

Spend over a time range, grouped by any of: conversation, tree (the root a conversation descends from, by owner then
fork parent), agent, model, provider, vendor, family, token kind, thinking level, status, tool, hour of day, day,
week. A group can be split again by a second dimension, and every filter narrows all of it. The summary has the
range's dollars against the same-length window before it, responses, the cache hit rate (cache reads over all prompt
tokens), what the cache saved (cache reads priced as plain input, less what they cost), what it leaked (see
[Cache](#cache); the figure leads to the cache view), overhead, and the share of dollars that are the price table's estimate rather than the provider's bill.

- **Vendor** is the provider, except the Shopify AI Proxy's routers (provider `proxy`, models such as
  `shopify/explore`), shown as `Shopify proxy`: they serve several vendors' models and are priced by the one that
  answered.
- **Agent** is the conversation's agent definition (`ultimate.agent-profile`: scout, advisor, panel, judge…), else
  its label without the ` · …` suffix (`judge · evidence` → `judge`), else `agent`; `@ultimate` (#1) is `ultimate`.
- **Family** is the conversation's model family (`models.family`: lead, default), `(pinned)` when its definition
  pins a model.
- **Status**: `busy`, `concluded`, `open`, or `earlier chapter` for conversations only the history file knows.

## Where the numbers come from

Each row is one model response, an own `pi.assistant` entry of a conversation, with the tokens and dollars that
response recorded: exact as the store holds them. A forked conversation's history includes the entries it inherited;
those are left out (they are the parent's spend), so a side chat costs only what it spent itself.

A conversation's `pi.usage` holds its whole spend. What it holds beyond its responses (titles and summaries, keep-warm
pings, compaction attempts) becomes an **overhead row** per `provider/model`, for residuals over $0.0005, placed at
the conversation's latest activity; spend inside tools (`pi.usage.tools`) becomes one overhead row (provider
`tools`, model `direct`) with each tool's dollars in `direct`. So the rows of a conversation add up to its
`pi.usage` total, to within $0.0005 per model.

When a response's provider reported the bill (`totalFromProvider`), its total is that bill, else the price table's.
Prices come from the host's model descriptors (dollars per million tokens).

The server reads every conversation once when the harness opens, then follows the store's commits: a `pi.usage`
change of a conversation reads its new entries about 2 s later (more changes in that time wait for the same read).
Titles, labels, busy and concluded are read when the surface asks.

`snapshot({ version, epoch })` answers `{ readAt, delta }`. `delta` is `null` while nothing changed since the version
the surface holds; else only the conversations that changed after it (each conversation carries the version of its latest change), each with only
the rows the surface lacks: `{ from, rows }`, keep the first `from` rows held and replace the rest. Responses only
append, and each is stamped with the version it first went out in, so `from` is how many of them the surface's
version holds; the overhead rows after them are recomputed and always come again. The surface polls it every 30 s
while shown; `readAt` makes each answer new, so an unchanged one still reaches it and "read … ago" stays true.

Versions are wall-clock, so they only mean something within one server instance: `epoch` is that instance, and a
number from another one — the surface's version after a reload, or a reload's after a restart — says nothing about
this data. With no version, or one of another `epoch`, the server returns everything (`from: 0`). The surface folds
each answer into what it holds with `merge` from `model/data.ts`, which replaces what it holds rather than folding
into it when the answer is another instance's; every aggregate function reads that `SpendData`.

## Spend by tool

An **estimate**, made by splitting each response's real cost; nothing is priced at an assumed rate.

1. **How big each result is.** Between two responses, the prompt grows by everything added in between:
   `prompt(n+1) − prompt(n) − output(n)` tokens, where a prompt is input + cache read + cache write. That growth is
   split across the entries added between them (tool results, user inputs, notes) by their text characters, an image
   counting as 4000. Only tool results are named by their tool. The first response after the start, a compaction or a
   reset has no previous prompt: its new results count 2.5 characters per token (about what JSON results take).
2. **What it is carried in.** A result stays in every later prompt until a compaction or reset, so each response's
   prompt carries every result before it. The tool's share of a response is the prompt dollars (input + cache read +
   cache write) times its results' tokens over the prompt tokens (all tools together at most the whole prompt), plus
   the output dollars times its call arguments' characters over everything the response wrote (text, thinking and
   call arguments). The rest of the response is `(no tool)`.
3. **Direct spend** inside a tool (`pi.usage.tools`) is added under its name; the rest of the overhead is
   `(overhead)`.

Per tool the surface shows its dollars, its direct dollars, its results' tokens over the prompt tokens of the responses
shown (filtering by a tool keeps the responses that carry one of its results), and how many prompts each of its
results was sent in on average (rereads).

Limits: the split assumes every added character costs the same, which is close for JSON and text and rough for
images; a context edit or a compaction that keeps recent entries makes later shares a little off; the output share
counts characters, not tokens; filtering by a tool and a token kind at once multiplies their shares, since a tool's
dollars are not known by kind. Shares are kept to a nano-dollar and a whole token.

## Cache

Every response has one **cache class** (the `Cache` dimension), from its own tokens:

- **idle rewrite**: it wrote more than half its prompt into the cache after 5 minutes or more since the conversation's
  previous response (the cache had expired).
- **first/changed**: the same rewrite without that gap: a first response, a compaction, a changed prefix.
- **hit**: cache reads are at least half the prompt.
- **miss**: a prompt of 8k tokens or more that is mostly plain input, with no cache write: a provider with implicit
  caching (Gemini, xAI, OpenAI) that did not hit it.
- **partial**: the rest of the prompts of 8k or more; **uncached**: smaller prompts, which providers do not cache.

A class's **leak** is what a warm cache would have saved: a rewrite's cache writes priced as cache reads instead, a
miss's input priced as cache reads instead. A rate is what the response itself paid per token of that kind, else the
price table's, else the price table's of the model that answered (a router's own models such as `shopify/dev` carry no
prices). Cache savings use the same rates, so routed responses count too.

The **idle gaps** bucket idle rewrites by the time since the previous response. Two what-ifs, both estimates:

- **Pinging while away**: a ping every 4½ minutes holds a five-minute cache, so an idle gap of `g` needs `⌊g / 4½ min⌋`
  pings, each reading that response's prompt from the cache; gaps of 8 hours or more get none (keep-warm stops then).
  Saved: those rewrites' leak.
- **One-hour cache**: every cache write priced at twice the input rate (Anthropic's one-hour price) instead of what it
  paid, on the models whose writes cost more than input; saved: the leak of idle rewrites under an hour, which it reads
  instead of writing, so they pay no write premium.

Neither counts how a ping or a longer cache changes what the conversation does next. Nor is pinging while away
something Ultimate does: keep-warm pings only @ultimate, 55 minutes after its last cache request, on `claude-code` or
on `anthropic` with long retention, and the card says so.

**Ask agent**, on the Cache header, puts a brief of what the cache view shows into @ultimate's message box, unsent and
at the cursor, so a draft stays: the range and filters, the leak and both what-ifs with their assumptions, the causes
with their pauses, the five conversations and the five models that leak the most (`cacheBy`), what keep-warm really
does, and where each setting lives (agent models and families, Pi's `compaction` with `modelOverrides`, keep-warm,
`PI_CACHE_RETENTION`). It names no one's settings, only where they are, and asks the agent to propose changes on a
question card and change nothing without a yes. `model/brief.ts` builds it.

**Model** labels a router's model with the model that answered it (`responseModel`, kept as `served`) when all its
responses name one: `proxy/shopify/dev → claude-opus-5-5`. Rows saved before this have no `served`.

**Prompt size** bands each response by its prompt (input + cache read + cache write): under 50k, 50–100k, 100–200k,
200k and more; they list smallest first. The **priciest turns** are the filter's ten most expensive responses; the
surface shows five at first, each with why: its leak (an idle rewrite with its pause, a first or changed prompt, a
miss), else what most of its dollars paid for (output, cache reads, cache writes, plain input).

## Forecast

Week (Monday to Sunday) and month: what was spent so far, today included, plus a daily rate times the time left, the
rest of today counting as the part of it still to come. The rate is the mean of the last 7 complete days (today never
counts: it is still running). With fewer than 7 complete days it is not a forecast yet and says how many more days it
needs; from 14 days on it carries an ~80% band, ±1.28 σ √(days left), σ the spread of the last 28 complete days. With
a weekly or monthly budget it says whether the projection goes over. No weekday pattern: a weekend shows as a lower
rate only once it is among the last 7 days.

A **daily budget** holds each day against it: the spent cell counts the range's days over it (one day: how far
under or over, and for today, once the forecast is ready, whether the rest of the day at the rate passes it), and the
per-day chart draws it as a dashed line. Like the others, it is skipped while filters are on.

## History file

`<home>/costs-history.json`: every row and conversation the server knows, each with the chapter it was saved in,
and the prices; written at most once a minute after something changed (and when the harness closes), to a temporary
file of that write renamed over the old one, which is removed if the write fails. On open the server reads it and
keeps the conversations the store does not hold (an earlier chapter: each chapter is a database of its own) as
`live: false`, with their rows; every conversation the store holds is read from the store.

Every chapter but the active one is read from its own store, read-only, on each open — the first chapter is
`<home>/state.sqlite`, every later one `chapters/<name>/state.sqlite` — so spend from before the tab started saving,
or from while it was off, counts too. Each conversation the store holds replaces what the file saved of it; one the
file saved and the store no longer holds (deleted while its chapter was active) stays. Each of its conversations' entries go through the same allocator as a live one's (a
fork's inherited ones first, through the fork point: they shape its context, but only its own responses become rows,
so a parent's spend is not counted again), and its `pi.usage` gives the overhead rows, so the
rows of a chapter add up to its `pi.usage` total. A store it cannot read is a notice, and the chapter keeps what the
file saved of it.

Conversation ids repeat across chapters (every chapter's @ultimate is #1), so a chapter and an id name one together.
A conversation kept from another chapter takes a reserved negative id in what the surface reads — a store id is
never one — and its rows and its owner, parent and root refs are given the same ids, so two chapters' #1 stay apart.
A file it cannot read as history, or one written before this, whose ids cannot be told apart, is left alone and
nothing is saved over it.

`node scripts/seed.ts <path>` writes a synthetic one, ~35 days of conversations run through the real allocator, for a
preview.

## Enable

It ships off. Turn it on for this machine in `~/.ultimate/settings.json`, or for one project in
`<project>/.ultimate/settings.json`:

```json
{ "extensions": { "enable": ["ai-spend"] } }
```

The Spend tab appears in the top bar, and ⌘K **Open Spend** opens it.

## Tests

`pnpm test extensions/ai-spend/`. `model/` is pure (every import in it is another file of `model/`), so it runs in Node
and in the browser alike; `test/boundaries.test.ts` keeps it that way.
