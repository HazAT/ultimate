Search the public web and fetch clean page content with exa.ai through `web_search` and `web_fetch`. It ships off; turn it on in the Extensions panel. It needs `secrets` on as well, and `parallel` off: both register `web_search` and `web_fetch`, so the host refuses whichever of the two loads second (`web_search is already provided by …`).

Set `EXA_API_KEY` in the Secrets panel (⌘K → Secrets), obtained from https://dashboard.exa.ai/api-keys. The user-global secret store takes priority over `EXA_API_KEY` in the server environment. Missing credentials produce a tool error and one process-local notice, never an in-chat credential form.

`web_search` calls Exa `POST /search` (`type: auto`, highlights as excerpts); `searchQueries` variants run as parallel searches guided by the main query and merge by rank, deduplicated by URL; `afterDate` maps to `startPublishedDate`. `web_fetch` calls `POST /contents` with full page text (40k characters per page, `maxAgeHours: 24` for freshness) and uses `objective` as the highlights query. Calls are read-only and replay-safe, with a 120-second timeout and cancellation. Text output is capped at 50 KiB / 2000 lines; structured details carry results, excerpts, pages, errors, and warnings. For raw files, APIs, JSON feeds, and localhost, use curl instead.

Derived from Ultimate's built-in `parallel` extension (MIT, Copyright (c) 2026 haza, itself ported from [HazAT/pi-parallel](https://github.com/hazat/pi-parallel)): parameter schemas, guidance, output limiting, details shapes, and the renderers follow it, with the Parallel API swapped for Exa's. `ULTIMATE_EXA_TEST_URL` overrides the API base only for local fake-server tests; never set it in production.

## UI

`web_search` and `web_fetch` render from their `details`, collapsed while they succeed:

- **search:** the query, the top three domains, and `n results`; expanded, each result's title as a link, its domain, date, and a three-line excerpt.
- **fetch:** the URL or the top domains, and `n pages`; expanded, each page's title and source link, and its content as markdown behind a disclosure (open for a single page).
- **Failures and warnings:** counts in the header and one compact line each when expanded. A failed call opens itself to show the error with its HTTP status and request id.
- **Missing or rejected key:** Add key (Replace key) beside the header opens the Secrets panel at `EXA_API_KEY`; while `secrets` is off, Turn on secrets opens the Extensions panel.

The renderers request nothing from the web: links load only when followed, and fetched markdown renders without images.
