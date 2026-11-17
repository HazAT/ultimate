Lets agents search the web and read web pages (needs a Parallel API key). It searches the public web and fetches clean page content with parallel.ai through `web_search` and `web_fetch`, and needs `secrets` on as well.

Set `PARALLEL_API_KEY` in the Secrets panel (⌘K → Secrets), obtained from https://platform.parallel.ai. The user-global secret store takes priority over `PARALLEL_API_KEY` in the server environment. Missing credentials produce a tool error and one process-local notice, never an in-chat credential form.

Calls are read-only and replay-safe, with a 120-second timeout and cancellation. Text output is capped at 50 KiB / 2000 lines; structured details carry results, excerpts, pages, errors, and warnings. For raw files, APIs, JSON feeds, and localhost, use curl instead.

Ported from [HazAT/pi-parallel](https://github.com/hazat/pi-parallel) at `75d933b`, MIT, Copyright (c) 2026 haza. Parameter schemas, request shaping, guidance, and output limiting follow that extension; adapted to Pi Durable. See the upstream MIT license. `ULTIMATE_PARALLEL_TEST_URL` overrides the API base only for local fake-server tests; never set it in production.

## UI

`web_search` and `web_fetch` render from their `details`, collapsed while they succeed:

- **search:** the query, the top three domains, and `n results`; expanded, each result's title as a link, its domain, date, and a three-line excerpt.
- **fetch:** the URL or the top domains, and `n pages`; expanded, each page's title and source link, and its content as markdown behind a disclosure (open for a single page): `content` when the server sends it, otherwise the excerpts.
- **Failures and warnings:** counts in the header (`1 failed`, `1 warning`) and one compact line each when expanded. A failed call opens itself to show the error with its HTTP status and reference.
- **Missing or rejected key:** Add key (Replace key) beside the header opens the Secrets panel at `PARALLEL_API_KEY`; while `secrets` is off, Turn on secrets opens the Extensions panel.

The renderers request nothing from the web: links load only when followed, and fetched markdown renders without images.
