---
name: integrate-ultimate
description: Integrate Ultimate into an existing project. First investigate the project and how its people work on it, then suggest a small set of project-specific extensions, surfaces, agents and settings, and build the chosen ones into <project>/.ultimate/. Use when someone wants to "use Ultimate in this project", "set up Ultimate here", asks what Ultimate could do for a repository, or wants a review team or a lander (checks and push on landing) set up for a project.
---

# Integrate Ultimate into a project

Ultimate is meant to be specialized per project. Built-ins give every project the same agent. A project's `.ultimate/` folder, committed with the repository, adds what only that project needs: settings, agents, skills, and extensions with tools, panels and full-screen surfaces. Everyone who starts `ultimate` in the folder then gets the specialized agent; onboarding asks once whether to use it.

Work in three phases. Do not build anything before the user has chosen.

## 1. Investigate (read-only)

Gather evidence, citing file:line, before forming opinions.

- **Identity:**
  - the remote and whether it is private, since that decides whether to push after building;
  - what the project is;
  - the stack and its real versions (manifests win over docs; READMEs and agent docs are often stale).
- **How it runs:**
  - the dev, build, test and lint commands and the dev server port;
  - deploy;
  - required secrets, by name only (never print or read values; read `.env` keys only by name).
- **The domain model:** what the project's "things" are (posts, services, tickets, datasets), where they live, their states, and how they are created and changed.
- **What Ultimate already has:** the clone's `extensions/` and the open feature pull requests (`gh pr list --repo HazAT/ultimate --label feature`). Adapting one into `.ultimate/` beats building from scratch; change the clone's core only for a clear-cut fix, since edits there conflict with every update.
- **Existing agent assets:** `AGENTS.md`/`CLAUDE.md`, `.pi/skills/` (Ultimate loads these as-is), `.claude/`, prompts, and scripts that agents already drive. These encode the real workflow; reuse them and don't reinvent them.
- **How people actually work:**
  - `git log` subjects;
  - recent agent conversations or threads, if any (in Ultimate: `ultimate.projects()` and conversation search in codemode);
  - TODOs and docs.

  Note what they repeat by hand, what they check in a browser, and which steps cost money or are irreversible.

## 2. Suggest

Map the findings to Ultimate's building blocks:

| Need                                        | Building block                                                                |
| ------------------------------------------- | ----------------------------------------------------------------------------- |
| The agent should know project rules         | `AGENTS.md`/`CLAUDE.md` (already read), or a skill in `.ultimate/skills/`     |
| A recurring multi-step workflow             | a skill (`.pi/skills/` or `.ultimate/skills/`), driven from the conversation  |
| A specialist role                           | an agent definition in `.ultimate/agents/<name>.md`                           |
| Seeing and acting on the domain's things    | an extension with a **surface** (a full-screen app) or a panel                |
| A deterministic operation                   | an extension **action** or **tool** that reuses the project's scripts         |
| A long-running process (dev server, render) | a server facet that manages a child process and cleans up `onClose`           |
| An API key                                  | declare it with `secrets` and read it server-side only                        |
| Recurring work                              | `automations`                                                                 |
| Review by several models, one verdict       | a review team in `agents/` (see "Review team and lander")                     |
| Checks and a push on every landing          | `lander` settings, optionally a `lander` agent (see "Review team and lander") |
| Which built-ins are on                      | `.ultimate/settings.json` `extensions.enable`                                 |

Propose **2–4 ranked suggestions**, not a catalogue. For each, say what the user sees, what it reuses, and what it needs (secrets, processes, costs). Principles:

- **Reuse:** surfaces call the project's own scripts and skills; the agent does the judgment work in the conversation, and the surface shows state and offers one-click entry points.
- **Deliberate costs:** steps that cost money or are irreversible (paid APIs, deploys, publishing) are explicit, human-confirmed clicks.
- **Secrets stay server-side:** never in tool output, the transcript, or the browser.
- **Start small:** one or two surfaces that remove the biggest context switch beat a dashboard of everything.
- **Built-ins:** enable the useful ones. `self` is for developing Ultimate itself; leave it off elsewhere. Keep `instance` on when the project has its own extensions: coordinators preview them with it.

Ask the user to choose, offering defaults. Ask only questions whose answers change what gets built.

## Review team and lander

Both work without setup: the shipped `reviewer` reviews alone on the parent's model, or leads any `reviewer-*`
definitions, and `workspace submit` merges and
fast-forwards with no checks and no push. Ultimate's own clone is the working example: the `adopt-ultimate-setup` skill
tours its `.ultimate/` and adapts the chosen pieces (models, checks, review focus) to the project.
Worker reports and submissions state divergence from the task as given (agreements, approach, scope), or "None";
`workspace submit` requires that `divergence` string, and lander reports distinguish any additional changes.

- **Review team:** agent definitions, so it can live in `<project>/.ultimate/agents/` or, for every project, in
  `~/.ultimate/agents/` (a project's file wins by name). Add one `reviewer-<name>.md` per reviewer; the shipped
  `reviewer` then starts them all in parallel and merges their reports, so never override `reviewer` itself. Each is pinned to a different model the
  user is logged in to and named after what it checks (`reviewer-correctness.md`, `reviewer-simplicity.md`,
  `reviewer-architecture.md`). Details: "Review team" in
  `extensions/subagents/README.md`.
- **Project tools or settings for a built-in agent** (@ultimate, the coordinator): never copy its definition. Add
  an overlay, a file of the same name marked by `addTools: [tool]` (`[]` when it only changes settings). It may
  override any setting (`model`, `thinking`, `description`, …) but never `tools`, and its optional body
  is appended to the built-in instructions as project additions; a copy stops following the built-in and the setup
  check warns about it.
- **Lander:** checks and push are per project, in `<project>/.ultimate/settings.json` (read once the project is
  chosen): `"lander": { "checks": [...], "push": "origin" }` lists the project's own check commands in order (an array
  runs as a concurrent group) and the remote to push to; push only with the owner's consent. The lander's checkout
  runs the worktree setup below first. The lander runs no model: a conflict or a failing check goes back to the
  submitting branch, which fixes it and submits again. Details: `extensions/workspaces/README.md`.

## Worktree setup

Every coordinator, worktree subagent and the lander works in a fresh `git worktree`, which has none of the
project's ignored files: no dependencies, `.env`, database, generated files or dev-server port of its own. Always check
this, even unasked (setup health warns while it is missing), and propose it. When the user decides the worktrees
need none, write `"setup": []`: the explicit empty list is the decision, and the warning stops.

- **Read:** the package managers and lockfiles, `.env.example` and how `.env` is made, the database config (driver,
  file path), generated files the build or tests need, and the dev-server scripts and their ports.
- **Write** `isolates.worktree.setup` in `.ultimate/settings.json`: a list of shell commands, run in order in the new
  worktree with `ULTIMATE_SOURCE` set to the source checkout, before the conversation's first tool call. A list that
  grows past a few lines goes into `.ultimate/worktree-setup.sh`, referenced as `["sh -e .ultimate/worktree-setup.sh"]` (`sh` ignores the shebang, so `-e` goes here).
  Every command must be safe to repeat, and each has 120 seconds.
- **Recipes** (no Ultimate support needed):
  - Dependencies: the lockfile installs (`pnpm install --frozen-lockfile --prefer-offline`, `npm ci`,
    `composer install --no-interaction`).
  - `.env`: `[ -f .env ] || cp "$ULTIMATE_SOURCE/.env" .env`, so keys work as in the source checkout.
  - SQLite: a copy-on-write clone of the source's file, instant and free until written:
    `cp -c` (macOS) or `cp --reflink=auto` (Linux), only when the worktree has none yet.
  - A dev port of its own: the worktree folder ends in its conversation id (`<home>/worktrees/<id>`, or
    `ult-<hash>-<id>` under a configured `isolates.worktree.path`), so `id=$(basename "$PWD"); id=${id##*-}` then
    `PORT=$((20000 + id % 1000 * 10))` gives a stable block of 10, written into `.env` (APP_URL, the server and Vite
    ports). Check the dev script actually reads it.
  - The lander: its checkout is `<home>/lander/<hash>`, or `ult-lander-<hash>` under a configured `path`; skip the
    database and dev-server steps there (`case "$PWD" in */lander/*|*/ult-lander-*) exit 0;; esac`) and keep what the
    checks need.
- **Ask** before Postgres, MySQL or anything needing credentials: whether worktrees share the developer's database
  or get their own (`createdb -T <db> <db>_wt_<id>`, or a dump), and where credentials come from. Never copy
  production data into a worktree without the owner saying so.
- **Prove it:** create a scratch worktree the way Ultimate will: `git worktree add --detach <tmp>/1 HEAD` (a numeric
  folder, like a real worktree), or the project's `isolates.worktree.add` command at its configured `path` when it
  sets one, since its tooling may refuse worktrees made any other way (`extensions/workspaces/README.md`). Run the
  commands there with `ULTIMATE_SOURCE` set, run the project's checks or start the dev server, then remove the scratch
  worktree (with `isolates.worktree.remove` when it is set). Commit the settings and script.

```sh
#!/bin/sh
set -e
# .ultimate/worktree-setup.sh for a Laravel + npm app with SQLite
composer install --no-interaction --prefer-dist
npm ci --prefer-offline --no-audit --no-fund
[ -f .env ] || cp "$ULTIMATE_SOURCE/.env" .env
php artisan wayfinder:generate --with-form
case "$PWD" in */lander/*|*/ult-lander-*) exit 0;; esac
[ -f database/database.sqlite ] || cp -c "$ULTIMATE_SOURCE/database/database.sqlite" database/ 2>/dev/null \
  || cp --reflink=auto "$ULTIMATE_SOURCE/database/database.sqlite" database/
id=$(basename "$PWD"); id=${id##*-}
PORT=$((20000 + id % 1000 * 10))
status=0; grep -v -e '^APP_URL=' -e '^SERVER_PORT=' -e '^VITE_PORT=' .env > .env.tmp || status=$?
[ "$status" -le 1 ] # 1 only means no other lines
printf 'APP_URL=http://127.0.0.1:%s\nSERVER_PORT=%s\nVITE_PORT=%s\n' "$PORT" "$PORT" $((PORT + 1)) >> .env.tmp
mv .env.tmp .env
```

Paths above are relative to the Ultimate clone (`../..` from this skill). Definitions are reread on every start and
settings apply live; nothing needs a restart.

## 3. Build and verify

- **Configuration, written directly:** `.ultimate/settings.json`; `.ultimate/README.md`, a short explainer that onboarding shows; agent definitions; skills with their small helper scripts.
- **Extensions go to a coordinator branch** (as @ultimate, start one per picked extension with the user's words; a coordinator builds it): one folder per extension in `.ultimate/extensions/<name>/` (`server.ts`, `web.tsx`, `README.md`). Follow `extensions/README.md` in the Ultimate clone.
  - Extensions outside the clone import what built-ins import (`@/sdk`, `@/components/…`, clone packages), and nothing type-checks them.
  - Keep the project's own tooling (type check, lint, format) from scanning `.ultimate/`.
  - A worktree's `.ultimate/` does not hot-reload the running host. Preview it with `instance start`: a clean instance (every agent on `instance.model`) that runs the worktree as its project and loads its `.ultimate/extensions`.
- **Verify against the real project**, not a copy of Ultimate: the preview above, or a temporary `HOME` with the project trusted (`~/.ultimate/trust.json`) and onboarding done, then `node <clone>/bin/ultimate.ts <project> --port <free> --no-open`.
  - Check the extension info for load errors.
  - Call the actions.
  - Open the surfaces in a browser and take screenshots.
  - Never spend money or deploy while verifying.
- **Commit** in the project repository: push if it is private and the owner's policy is to push; ask first if it is public or shared.
- **Hand off:**
  - how to start it (`ultimate` in the folder);
  - what onboarding will ask;
  - what each surface does;
  - which secrets to add in the Secrets panel.
