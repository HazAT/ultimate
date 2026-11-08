# Ultimate

Ultimate is a local coding agent with a web UI, built on Pi Durable (`@earendil-works/pi-durable`). It runs this
repository while it edits it: you are probably reading this as Ultimate, about to change yourself. Everything below
tells you which change reloads how, so the conversation you are in keeps running.

## How work is organised: a forest of conversation trees

A project is a forest of conversation trees, like commit histories.

- **Roots** run no turns. Each keeps a project memory (decisions, facts, lessons by slug); a branch starts from the
  root's memory index and recent landings. The root's read-only tally stays the browsable project context: branch
  intents, latest conversation abstracts and landings with divergence and `#conversation/entry` breadcrumbs. The UI
  calls a tally **context** and shows it as the read-only **History** page (the sidebar's project path opens it), with **Open in Zed** and **Back to
  @ultimate**; the sidebar's Memory row shows the memory's estimated tokens (what a branch starts from) and opens the
  Memory surface.
  Start a project with @ultimate: Continue on Get ready, or **Set up with @ultimate** on the Start here card that
  @ultimate's conversation shows until onboarding has run. It walks the user through Ultimate, handles setup
  cards, reads the project and writes its first memories with `remember`; the user's answer about the project
  becomes instructions, kept verbatim as a memory. The tally then builds up from branches and landings. @ultimate maintains memory with
  `remember` and the memory review (`extensions/lineage/README.md`); the user can compact a tally with ⌘K
  Compact while it is shown. A project has one root: independent work goes into branches.
  Roots and standing agents are never concluded or cleared, only compacted.
- **A branch** is a feature, a fix, an experiment. @ultimate picks a root by reading its tally, then starts a
  coordinator branch that starts from its memory brief (or, without memories, its tally) before its prompt. A branch is never a subagent.
- **Talk to @ultimate in its conversation.** The user's standing agent starts and steers branches there.
  The first sidebar row (on phones, the top-bar **@ultimate** button) opens it; its messages and questions to you appear in that transcript.
  Conversations and roots are not created by hand.
- **Branches ask you in their own conversation.** A coordinator sends its decisions to @ultimate, which weighs in
  (its picks, or deciding itself on a hands-off goal); the branch then asks you with a card there. @ultimate's
  conversation shows a pointer to it, and your answer reaches @ultimate as a note.
- **Coordinators carry the work.** A branch is the conversation; the coordinator is the agent that runs it, so the UI
  labels it `branch · coordinator`. A branch plans, decides and verifies; subagents are for bounded execution and
  reconnaissance, and the lander is the final gate on main.
- **Zoom out when you need to.** Read any root or sibling with codemode `ultimate.entries(id)` and
  `ultimate.search()`; commits name the conversation that made them (`Ultimate-Conversation` trailer).
- **Talk across the tree without waking anyone.** `note` leaves context in another conversation for its next turn;
  `notify` tells you when another conversation finishes. Resuming a branch brings a catch-up of its tree's tally
  (older updates collapse when needed), then new target commits, overlaps first.
- **State divergence.** Reports and `workspace submit` say how the result differs from the task as given: new
  agreements, a different approach or changed scope. Say "None" when it matches.
- **Conclude** a conversation when its work is done; it stays readable and can be resumed. A branch whose submission
  lands is concluded by the landing, unless work is still under way (a subagent, a reply it waits for, queued input, an automation it subscribed to
  that is still enabled),
  and whoever started it wakes with the landing card. A failed submission wakes the branch to fix it and submit again.
- **UI polish lands when the user says so.** For small look-and-feel work (an animation, a loading state, spacing,
  a card), run preview rounds (the `ui-preview-round` skill) and do not `workspace submit` until the user has clicked
  around and approved it. Larger UI features and anything with behaviour behind it land as usual.
- **Hands-off goals.** ⌘K Go hands-off… puts @ultimate on a goal while the user is away: it gives the go, decisions
  and preview approvals in their place and records each with its reason (`extensions/goal/README.md`).

`extensions/lineage/README.md` has the mechanics.

## Layers and how they reload

| Path                          | What lives there                                                                                                                                                                                      | How a change goes live                                                                                                                                                                                 |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `extensions/<name>/web.tsx`   | UI of an extension: slots, panels, surfaces, tool and entry renderers, commands                                                                                                                       | Rebuilt into the page about 2 s after a save; open pages switch to the new bundle (drafts and view kept). A broken facet shows an error card; the rest keeps running.                                  |
| `extensions/<name>/server.ts` | Agent behaviour: system prompt, tools, hooks (Pi Durable extensions)                                                                                                                                  | Reinstalled on save. Running tool calls finish on the old code; the next call uses the new code.                                                                                                       |
| `extensions/<name>/api.ts`    | Its contract for other extensions; `export const tier = 'core'` puts it in the always-on core tier, which depends only on the core tier, one way ([the core tier docs](docs/extensions/core-tier.md)) | With the facets that import it.                                                                                                                                                                        |
| `lib/`                        | Pure helpers extensions share (exec, git, JSON and settings files, secret reads); no state, no extension imports                                                                                      | Like the extensions that import it: rebuilt or reinstalled on save.                                                                                                                                    |
| `web/`                        | The web core: surface host with primitives, SDK (`web/src/sdk`), transcript, composer, palette                                                                                                        | Rebuilt and switched to like a `web.tsx`. Nothing else to do.                                                                                                                                          |
| `agents/`                     | Subagent definitions (Markdown with frontmatter)                                                                                                                                                      | Read at each use.                                                                                                                                                                                      |
| `server/`, `shared/`          | Core plumbing: harness, storage, API, Vite hookup                                                                                                                                                     | Call the `restart` tool. A new process boots and type-checks next to the old one; if it fails you get the error and the old process keeps running. If it succeeds, the run resumes in the new process. |
| `bin/`                        | The supervisor                                                                                                                                                                                        | Only a human restart (`pnpm start`) applies it. Keep it tiny and change it rarely.                                                                                                                     |

Put behaviour in `extensions/` rather than `server/` whenever you can: it reloads without a restart. The browser runs a
production bundle (`server/web.ts`): a change to `web/` or a `web.tsx` rebuilds it in a short-lived child process, and
every open page reloads onto the new bundle, resuming the view and drafts it left; with no page open the next page load
builds it.
A surface is a full-screen app the user switches to (header, ⌘K, `mod+1…9`); the conversation itself is the built-in
`agent` surface, and a project's apps go in `<project>/.ultimate/extensions/` (see [surfaces](docs/extensions/surfaces.md)).
New UI is a new extension folder, not a change to `web/`: follow the `write-extension` skill, which points into
[extensions/README.md](extensions/README.md), and copy the closest existing one (`status-line`, `coding-tools`).

## Developer reference — read when needed

- [Running the server](docs/running.md): before starting, debugging or testing a server or core swap.
- [Worktrees and integration](docs/worktrees.md): before previewing an isolate, landing or recovering a rejected push.
- [Discovery and settings](docs/settings.md): before changing configuration, trust, resources or `summaryModel` (titles, summaries, reply summaries and tree abstracts).
- [Durability](docs/durability.md): before changing persistence, replay or durable UI state.
- [Extension topics](extensions/README.md#topics): before wiring facets, contracts, documents, events or runtime inspection.
- [Subagents](docs/subagents.md): before delegating, changing definitions or configuring the review team.
- [Borrowed from Pi](docs/pi-upstream.md): on Pi upgrades or changes to upstream couplings; includes upstream references.
- [Searching Pi's code](docs/pi-upstream.md#searching-pis-code): before reading Pi internals; where each package's types live and the `rg` command that finds them.

## Push permission

The top-level agent may commit verified work, land it and normally push the destination branch to `origin`
(`HazAT/ultimate`), public or private, without asking. `workspace submit` runs checks and pushes. Subagents commit
and report, never push. Never force-push, rewrite history or push secrets. This permission does not cover other
repositories, releases, publishing, deployments or GitHub issue/PR changes. A rejected push or remote advancement:
see [integration details](docs/worktrees.md#standing-permission-to-push-this-repository).

## Conventions

- Commits made through Ultimate's bash tool carry `Ultimate-Conversation: <id>`; find the conversation behind a commit with `git log --format=%(trailers:key=Ultimate-Conversation)`.
- Pi is the role model: minimal, readable, malleable. Prefer platform features and existing dependencies; justify every
  new dependency in its commit message.
- Public docs, READMEs, prompts, agent definitions, skills and code comments use generic names and examples ("the
  user", `my-app`, example addresses), never a real person's name, machine names, private repos or real IPs. LICENSE,
  upstream attributions and real repo URLs are exempt.
- `pnpm check` enforces import boundaries; see `lint/ultimate.ts` and `vite.config.ts`. It also runs `pnpm deps`,
  which prints the dependency graph between extensions (imports plus `need`/`want`) and fails on a cycle or on a
  core-tier extension that depends on an optional one.
- Plain TypeScript, ESM, Node 26 runs `.ts` directly: erasable syntax only (no enums, namespaces, or parameter
  properties), relative imports end in `.ts`.
- Core server/web contracts live in `shared/protocol.ts`; extension-local types live with their extension.
- Pin `@earendil-works/*` packages to exact versions; Pi Durable is experimental.
- Checks: `pnpm check` (format, lint, types) and the tests covering your change must pass before a commit; the lander runs every suite. Keep `pnpm test` fast: no real-time waits, no spawned processes (those go to `test/e2e`), and fix or delete a flaky test rather than skipping it or raising its timeout. Lint enforces this with `ultimate/no-test-timeout` and `ultimate/no-real-wait-in-fast-tests` (`test/e2e` is exempt); justified exceptions need a `fast-test-reason:` comment. Use the real-deadline `until` from `test/helpers.ts` (`ultimate/no-local-test-polling`). `ultimate/no-retired-ui` keeps retired UI labels and surfaces out of extensions and web code.
- Every user-visible result is designed, not dumped: status and outcomes (a subagent report, a landing, a failure) get a
  renderer that matches the existing cards (see `extensions/subagents/messages.tsx`, `extensions/workspaces/log.tsx`),
  never plain Markdown in a message. Look at the running app and recent screenshots first, write the expected look into
  task descriptions, and check a worker's screenshots against it before accepting.

## Review quality

Rules about how agents behave live in prompts and agent definitions, not in code. Code checks protect only safety and
invalid states: data loss, security, impossible states. Lint enforces only what the user explicitly asked for.

A swallowed error needs a reason comment explaining why ignoring it is correct; `ultimate/no-silent-catch` enforces this for empty catch blocks and empty or `undefined`-returning `.catch` handlers.
Likewise, code that exists only because of something outside it (an upstream bug, a provider quirk, a helper that
papers over a library, an edge case found in the wild) carries a short comment at the code naming its origin (the
issue or PR URL, our PR number or the `#conversation`), what breaks without it and, if known, when it can go, so a
later agent can rethink it.

Reject slop and jargon: keep code and explanations direct, minimal, and grounded in evidence. No backward-compatibility
shims or speculative fallbacks; move forward and update callers. Commit tests for a feature's core path and one
regression test per bug that actually happened; they exercise behaviour and failure cases, never restate the
implementation. Prove edge cases once instead (a throwaway test or script you run and delete, an action call, a
preview check) and show the command and its output in the report; one-off migrations and retired shapes get no test.
