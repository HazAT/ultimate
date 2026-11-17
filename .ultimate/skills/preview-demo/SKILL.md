---
name: preview-demo
description: Start, reset and stop an untouched demo preview of a worktree on a fresh recipe-list project, for the user to try a flow from the first prompt themselves. Use when a preview round needs an empty instance the user drives (not one you seeded), or the user asks to reset a demo to empty.
---

# Demo preview on a fresh project

`instance start` runs a worktree with that worktree as its project, which suits looking at Ultimate's own UI. When
the user wants to try a flow themselves (branches, their questions, landings) on a small, unrelated project from an empty
@ultimate, it needs its own project directory. That means a scratch server, as in `ultimate-provider-smoke`. `demo.ts`
does it in one call:

- It copies `fixture/` (a static recipe list: `index.html`, `app.js`, `style.css`, three recipes, and a `.ultimate/settings.json` with no lander checks, so landings are instant) into a new git repository with one commit.
- It gives the server its own home and a private copy of the user config, the same seed a preview gets.
- It starts the worktree's `server/main.ts` on the preview model, with every inherited `ULTIMATE_*` variable removed.
- It ties the server to the live supervisor, so it exits with the host and never touches the cloud backup.

## Start, reset, stop

Run from the worktree to preview. It needs `node_modules`, so run `pnpm install` there first if it is missing.

```bash
node .ultimate/skills/preview-demo/demo.ts start            # prints url, project, home, log
node .ultimate/skills/preview-demo/demo.ts start            # reset: stops it, fresh project and home, starts again
node .ultimate/skills/preview-demo/demo.ts stop
```

- `--port N` (default 4797) runs several demos side by side. Each port keeps its files in `/tmp/ultimate-demo-<port>/`.
- `--model provider/id` (default `openai-codex/gpt-6.2-sol`) picks the model every agent runs on.
- `project` only prints a fresh copy of the fixture as a git repository, to use somewhere else.

A reset always makes a new project copy and a new home. Never reset the old copy with `git reset` and worktree
removal: branches, worktrees and the lander's state all live in the home and must go together. `stop` kills the
process group recorded in its pid file. Never use `pkill -f` on a pattern, which also matches your own shell.

The first page load compiles the UI and stays blank for about 10 s. Then screenshot it before you hand it over:
@ultimate is idle with an empty transcript, and the composer shows the preview model. Do not send anything to it
yourself. The link is for the user, and an empty start is the point. A **1 setup issue** chip asks to trust the
fixture's `.ultimate/`. The user may trust it or leave it; landings work either way.

## Keep a seeded comparison separate

When you also want a preview you drive yourself (seeded with a run, to compare), start that one on another port
(`--port 4796`) or with `instance start`. Never seed the empty demo you are about to hand over. If you did, reset it.
Tell the user which link is which.

## What to hand over

The link (plus the tailnet URL from the server log, if any) and the prompt to paste first:

```
Please start three coordinators in parallel, one each, all small: (1) dark mode for the recipe list via prefers-color-scheme in style.css, (2) a search box above the list that filters recipes by name, (3) show the total cooking time of all recipes under the list. Each should just do it, commit and workspace submit without asking me anything. Tell me as each one lands.
```

Then the follow-ups that fit the flow under test, for example:

1. From @ultimate, with the search branch's number from its card: `Ask the search branch (#<id>) via a codemode script that calls message to it (reply: true) whether the search is case-insensitive. Tell me its answer when it comes.`
2. Typed into a branch's conversation: `Also make the search case-insensitive.`
3. `Sort the recipes alphabetically and keep the order when searching.`

Say what to expect, in the terms of the feature being previewed. Stop the demo when the round is over.
