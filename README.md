# Ultimate

> [!NOTE]
> **A personal project, shared as inspiration.** Ultimate is not a library or a product with users to support. Copy
> what you like, fork it, do whatever you want with it. To make it work your way, ask Ultimate to change itself; it
> keeps your changes in `.ultimate/` folders that survive updates. Pull requests are welcome as shared ideas: most stay
> open, unmerged, as references anyone can adopt, and I merge only clear-cut fixes or improvements to the core. I
> change things as I go, fundamental ones included, without migration paths or regard for anyone building on top.
> Whether that works for you is your call. See [CONTRIBUTING.md](CONTRIBUTING.md).

A coding agent you specialize for the project you work on. Start it in your repository and it is Pi's coding agent in a
web UI. Then build what this project needs into it, such as custom tools, panels, subagents, skills, or whole screens,
and keep them in the project's `.ultimate/` folder. Everyone who works on the project boots the same specialized agent,
and it still feels familiar in every project, because the core is always the same.

Built on [Pi Durable](https://earendil.com/posts/pi-durable/): the conversation, every tool call, and every subagent are
committed to SQLite before anything is shown, so Ultimate can rewrite its own UI, extensions, and core without losing its
place.

What Ultimate is and why it exists, in plain words: [danielgriesser.com/ultimate](https://danielgriesser.com/ultimate/).

## How to use it

- **Specialize it for your project.** Working on a web shop? Ask Ultimate for what makes work on that shop easier: a
  tool that queries the staging catalog, a panel that shows the order pipeline, a reviewer that knows your checkout
  rules, a skill for releases. It writes them as extensions, agents, and skills into `<project>/.ultimate/`, and they
  hot-reload while you talk.
- **Commit them with the project.** `.ultimate/` is part of the repository, so everyone who opens the project gets the
  same specialized agent. Ultimate asks once before it uses a project's setup, because project extensions run code.
- **One familiar core everywhere.** The conversation, Pi's tools, the model and login, and the way it works are the same
  in every project; only the project's own pieces differ. Your personal additions live in `~/.ultimate/` and follow you
  to every project.
- **Everything on, switch off what you don't need.** A fresh Ultimate is Pi's coding agent with every built-in:
  subagents, plans, documents, automations, remote access and the rest ship in the clone and are on by default; turn any
  of them off per machine or per project (see "Building blocks" below).
- **A forest of conversation trees.** Each root keeps a read-only context: branch intents, latest conversation abstracts,
  and landings with divergence and links back to their source. Talk to @ultimate in its conversation: it starts coordinator
  branches that inherit a root's context before their prompt. Resuming a branch catches it up on what its tree learned.
  @ultimate keeps each root's context accurate and compacts it without deleting history.
- **You can build whole applications in it, too.** A surface is a full-screen app next to the docked agent.
  The point is an agent shaped for the project you work on.
- **Lean and malleable.** Like Pi and Pi Durable, the core stays as small as possible and everything else is
  replaceable, including Ultimate itself: it runs this repository and can change its own code while you talk.

## Start

Paste this into Claude Code (or any agent) to get set up:

```text
Set up Ultimate (https://github.com/HazAT/ultimate) on this machine and get me to my first prompt.

Read these first; they are the source of truth, so follow them and don't invent steps: README.md (sections
"Start", "Recommended models" and "In your project"), AGENTS.md ("How work is organised"), docs/running.md,
and extensions/claude-code/README.md.

Then:
1. Check the prerequisites from README "Start": Node 26, pnpm, Git 2.54 or newer, and a Chromium for the screenshot tools. Tell me
   what is missing and how to install it on my system; ask before installing anything system-wide.
2. Clone the repository unless I'm already in it, run `pnpm install`, then `pnpm link --global` so I get the
   `ultimate` command; if pnpm's global bin is not on my PATH yet, `pnpm setup` adds it.
3. Model login, per "Recommended models": for Claude Code, install the CLI and let me run `claude auth login`
   myself; otherwise I log in from Ultimate's command palette (Ctrl+K, ⌘K on macOS) → "Log in to a provider".
   Never read, copy or handle my credentials.
4. Start it: `pnpm start` runs Ultimate on its own repository, `ultimate` inside one of my projects runs it there.
   Tell me to open the URL it prints (http://127.0.0.1:4747 for the first one), where Get ready asks for a login
   and a model the first time.
5. In a few sentences, using AGENTS.md "How work is organised", explain what I'll see: @ultimate in the first
   sidebar row, the command palette, and branches doing the work. Then suggest a first prompt, such as "Walk me through how you
   work" or a small real task in my project.

Stop and ask me whenever a step needs my password, a login or a decision.
```

By default you get Pi's coding agent in a web UI: read, write, edit, bash, codemode, and browser debugging tools,
with the conversation, model and thinking controls, login, and footer, plus every other built-in building block.

Needs Node 26, pnpm and Git 2.54 or newer.

You log in to a model provider on first start, not before. Ultimate shares `~/.pi/agent` with
`pi` (credentials, models, settings); personal skills and instructions go in `~/.ultimate/skills/` and
`~/.ultimate/AGENTS.md`. The
screenshot and browser tools need a Chromium: `/usr/bin/chromium`, Google Chrome, Playwright's cached Chromium, or
`ULTIMATE_CHROMIUM=<path>`.

```bash
pnpm install
pnpm link --global  # once, in this clone, to get the `ultimate` command (`pnpm setup` first if pnpm's global bin is not on PATH)
pnpm start          # Ultimate on its own repository; opens http://127.0.0.1:4747
cd ~/Projects/app && ultimate  # or Ultimate on one of your projects
```

- **First start** on a machine shows Get ready: log in to a provider and choose a model. Continue opens @ultimate,
  which offers inline setup cards, reads the project and writes the root's first context.
- **Logins** happen inside the UI: Get ready, or later the command palette (`Ctrl+K`, `⌘K` on macOS) → "Log in to a
  provider". Claude Code logs in with its own `claude auth login` (see "Recommended models"). Logins are shared with
  `pi`, and so is logging out; already logged in to `pi`, you skip this step. Log in on each machine; never copy
  `~/.pi/agent/auth.json` between machines, since a token refresh on one revokes the other's copy.
- **A folder with its own `.ultimate/`** asks once: its setup or your global one. Its extensions, agents, and skills
  stay off until you choose it; @ultimate asks with an inline setup card during onboarding.
- **The Extensions panel** (right panel, or `Ctrl+K` → "Extensions…") lists every extension and turns it on or off
  live, for this project or everywhere, and can change the project choice.
- On another machine: `ssh -L 4747:127.0.0.1:4747 <host>`, then open `http://127.0.0.1:4747`. Ultimate only listens on
  loopback.

### Recommended models

We recommend running @ultimate on Claude Code Opus 5.5 (`claude-code/claude-opus-5-5`), and ideally the
coordinators too; the other agents are your choice. Coordinators inherit @ultimate's model unless a definition pins
one, so choosing Opus 5.5 for @ultimate covers both (this repository's `.ultimate/agents/coordinator.md` overlay pins
it with high thinking). To set it up, install the CLI (`npm install -g @anthropic-ai/claude-code`), run
`claude auth login`, then pick the model in the model picker; ⌘K → **Claude Code setup…** shows the login status. The
[Claude Code provider](extensions/claude-code/README.md) is experimental: it depends on Claude Code's protocol and
account limits, and subscription coverage is not guaranteed. This is a recommendation only; no default changes.

### Terminal status

`pnpm start` / `ultimate` shows a compact live terminal dashboard: the public URL, supervisor/core lifecycle,
core generation and PID, embedded Vite readiness, registered extension services, and the last event. Routine
Vite/HMR output updates the dashboard instead of scrolling; warnings and errors remain in scrollback. Redirected
output is plain text with no dashboard escape sequences. Detailed, timestamped JSON lines (including routine
output and diagnostics) are appended to `<state home>/supervisor.log`. Past 8 MiB the file is renamed once to
`supervisor.log.1` and a fresh one starts, so the log stays bounded across long runs.
A log-write failure warns once and does not stop supervision.

Services are status reports, not separate processes. Automations reports `ready · durable scheduler` when the
harness opens; this does not claim that all runs are idle. Process topology and durable scheduling are unchanged.
Supervisor changes require a **manual stop and restart with `pnpm start`**; a core swap does not reload `bin/`.

### In your project

`ultimate [dir] [--port N] [--no-open]` starts Ultimate for a project (default: the current directory) and opens it
as its own chromeless window in a Chrome-family browser (`http://ultimate.localhost:<port>`), or a tab when there is
none. Running it again for a running project opens another window instead. Ultimate's own source stays in the clone;
the tools and the conversation work in your project.

- **`.ultimate/` in your project** tailors it: `extensions/`, `agents/`, `skills/`, and an optional `settings.json`
  (`defaultSurface` picks the surface to open). Ultimate also reads your personal `~/.ultimate/` the same way. Lookup
  order is the clone, then `~/.ultimate/`, then the project; later names win.
- **State** lives in `~/.ultimate/projects/<name>-<hash>/` (`ULTIMATE_HOME` overrides it), so each project keeps its
  own conversations, and several projects can run at once on their own ports (the first free one from 4747).
  All project homes are in one central place, `~/.ultimate/projects/`; Ultimate can list other projects and their
  conversations with `ultimate.projects()` in codemode, including their URL when running.
- **Actions** let an extension's UI call its server code: `export const actions = { … }` in `server.ts`, then
  `useAction(ref, args)` in `web.tsx`, with a typed `actionRef` from `@/sdk`. See [extensions/README.md](extensions/README.md).

### One Ultimate or many

Ultimate works both ways. Start it in one project and use it as an individual agent. Or run several: each project
is its own dedicated Ultimate process, on one machine or across several, and one Ultimate manages the others. It
reads their conversations, messages their @ultimate and watches their status; for example, a hub project whose
@ultimate checks the other projects and starts work in them. That is why every project gets its own process and
state home instead of one server for all of them.

The building blocks that make it possible:

- **Finding each other:** on one machine, every running instance shows up with its URL in `ultimate.projects()`
  and answers over loopback; no Tailscale needed. Across machines, list each instance in the `remotes` user setting,
  `{ "<machine>": { "<project>": "<url>" } }` ([Discovery and settings](docs/settings.md)).
- **Reading:** codemode's `ultimate.conversations`, `entries`, `search`, `trace` and `doc` take `{ project }` and
  read another running instance read-only ([Codemode](extensions/codemode/README.md#other-projects)).
- **Messaging:** `ultimate.tell({ project, text })` messages another project's @ultimate, and its answer comes back
  as a reply ([Messages](extensions/messages/README.md#other-projects-ultimates)).
- **Watching:** the `status` action reports an instance's health, failures and extensions in one cheap call
  ([Status](extensions/status/README.md)).
- **Reaching other machines:** the [Tailscale](extensions/tailscale/README.md) extension serves each instance on
  your tailnet, to your own login only.

## Building blocks

Built-ins live in the clone's `extensions/`, and every one is on by default; `tailscale` exposes Ultimate only to your
own Tailscale login. Each folder's README describes the building block.

Turn them off in `~/.ultimate/settings.json` for this machine or `<project>/.ultimate/settings.json` for this project:

```json
{ "extensions": { "disable": ["tailscale", "claude-code"] } }
```

See [discovery and settings](docs/settings.md) for precedence, enabling extensions, project trust and live updates.

## Surfaces

A surface is a full-screen app made of extensions: the **Agent** surface is the conversation you start with; another
can be anything you build. Switch in the title bar, `⌘K` → "Switch to …", or `mod+1…9`. The agent
stays docked on every surface, and the choice is durable: reloads, other tabs, and restarts land on the same view.
`documents` provides the Documents tab; surface UI contributions themselves work without it.

## What to try

- Start a new project with **Set up with @ultimate** on the Start here card in @ultimate's conversation (or Continue on the first-run Get ready page).
  Choose setup on the inline cards, steer its reading, then start your first coordinator branch from the project's context.
- Ask it anything about this repository; watch tool calls, diffs, and thinking stream in.
- "Build a surface for …" — a whole app with its UI, server actions, and the agent docked beside it; switch to it while
  it is being built.
- "Build a small extension that …" — it reads [extensions/README.md](extensions/README.md), writes
  `<project>/.ultimate/extensions/<name>/web.tsx`, and the UI hot-reloads in front of you.
- "Take a screenshot of yourself and tell me what looks off" — it can see and drive its own UI.
- "Delegate to a worker: …" — subagents run as their own conversations (Agents tab, `open #id`).
- "Use codemode to check which of your extensions failed to load" — one sandboxed script over its own runtime.
- Change something in `server/` and ask it to `restart`: a new process boots and type-checks next to the old one, and the
  conversation carries on in the new generation. A failed boot rolls back.
- Press `Ctrl+Alt+B` for the right panel: To-dos, Tasks, Activity, Automations (schedules and watching scripts),
  Agents, Documents (the plan, the codemode store, and every other extension document), Info (workspace, model,
  build, machine, skills) and Extensions, each a tab; Secrets and Claude Code open from ⌘K.
- Use @ultimate's row at the top of the sidebar (on phones, the top-bar **@ultimate** button) to ask for work, explore an idea, or start an independent line of work. Its messages and questions appear in its transcript, with answer cards beneath questions; open questions also wait at the top of the right panel's To-dos tab until you answer or dismiss them, and @ultimate's mark turns amber meanwhile.

## How it is put together

[AGENTS.md](AGENTS.md) is Ultimate's guide to itself: which path holds what, how each layer reloads, and the
conventions. Everything that is not core plumbing is an extension folder with a `server.ts` (agent) and/or `web.tsx`
(UI) facet; [extensions/README.md](extensions/README.md) is the guide to writing them.

## Develop

```bash
pnpm dev                          # the server alone, without the supervisor
pnpm check                        # format, lint, types
pnpm test                         # fast in-process tests on scripted model responses
pnpm test:e2e                     # tests that spawn real supervisors and instances
```

## License

[MIT](LICENSE).
