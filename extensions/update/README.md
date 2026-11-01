# Update

Keeps the Ultimate clone the host runs from (`host.ultimateRoot`, the `<self>` block's "Ultimate (running host)") current with its `origin`, by fast-forward only. On by default, so everyone hears about upstream changes; `extensions.disable: ["update"]` turns it off.

## Checking

Every running Ultimate compares the clone with `origin/<default branch>` every 5 minutes, and 30 s after start. That comparison is local and costs nothing. It fetches origin only when the clone's last fetch is older than an hour. The last fetch is read from `.git/FETCH_HEAD`'s mtime, so several Ultimates on one clone (each project's host) fetch at most once an hour between them, and a fetch by hand counts too. The fetch uses `lib/fast-forward.ts`, which retries a GitHub origin over the other transport (SSH ↔ HTTPS), and git never prompts. Fetches, summaries and updates hold a clone-wide lock (`.git/ultimate-update.lock`, the core's SQLite-held lock from `server/lock.ts`, released with its process), and the fetch's age and the summary cache are read again under it. Previews never check, and their `state` and `update` never touch the clone.

When a check finds a new range, the summary model is asked once (`ConversationsApi.askSummaryModel`) for 2–4 plain lines on what it brings. Its input is the range's commit subjects and bodies, never diffs, clipped to 12,000 characters. The answer is cached by `<head>..<origin head>` in `.git/ultimate-update-summary.json`, shared by every Ultimate on the clone; a missing or failing model caches no lines, and the popover shows the commit list instead.

## Status line

The item is always there (except on previews). While the clone is current it is a quiet, muted `✓ up to date` (just the ✓ on a phone); its popover says so, names the clone and when it was last checked, and offers **Check now**. Check now (`check`) fetches origin at once, bypassing the hourly gate but under the clone-wide lock, then recounts and summarizes as a background check does; the item spins meanwhile. When it finds commits the popover switches to the behind view, and updating stays a click on **Update now**. Check now also sits in the behind and refused popovers, so a clone can be re-checked after fixing it.

While the clone is behind, the status line shows `↓ 5 new · update` (`↓ 5 new` on a phone). It is amber with a warning icon when an update would be refused. The popover shows:

- the clone's path;
- how far `main` is behind;
- the summary, when there is one;
- the newest commits (3 under a summary, else 5) and a DiffsHub ↗ link to the range (GitHub origins);
- what the range touches: extensions and web, server, lockfile, bin;
- what each of those needs after an update:
  - extensions and web reload by themselves;
  - server or a changed lockfile need a restart of every Ultimate running from the clone;
  - a changed lockfile also needs `pnpm install`;
  - bin needs a supervisor restart.

**Update now** runs the update. After an update that needs a restart, the item reads `updated · restart`, and the popover offers **Restart now** (the core swap, as `core changed · restart` does). Every Ultimate on the clone shows it once packages were installed after it started, or once the clone's `HEAD` differs in `server/` or `shared/` from the commit it started from (a landing or another Ultimate's update), also when another one updated. While `pnpm-lock.yaml` differs from the installed packages, the item reads `install owed` and offers **Retry pnpm install**. Nothing restarts by itself.

## Updating

`update` (the popover's Update now; agents may call it too):

1. Fetches origin.
2. Fast-forwards the default branch with `git merge --ff-only`.
3. Runs `pnpm install --frozen-lockfile` when `pnpm-lock.yaml` differs from the installed `node_modules/.pnpm/lock.yaml`. A failed install is retried by the next update.

It refuses, and changes nothing, when:

- the clone has uncommitted changes to tracked files;
- it is on another branch or detached;
- it has diverged from origin;
- the lander is landing into the clone: on a machine where the clone is also the project, landings fast-forward the same branch. It is checked after the fetch, right before the merge; a landing that starts after that sees the moved branch and retries;
- another Ultimate holds the clone's lock.

It never stashes, rebases or resets.

## Updating with @ultimate

When the clone's only refusal is a diverged branch (commits of its own plus new ones on origin) and the clone is the project this Ultimate serves, the state carries `merge` and the popover offers **Update with @ultimate** instead of the refusal. The item stays brand-coloured, not amber. `merge` (user-only) checks the state again, sends @ultimate an input naming the branch, the clone and both counts, asking for a coordinator branch that merges `origin/<branch>` with a normal merge (never a rebase, reset or force push), resolves the conflicts it safely can, asks about the rest, runs the checks and lands with `workspace submit`. It then opens @ultimate's conversation. The input is deduplicated per `<head>..<origin head>`, so a second click adds nothing.

Where the clone is not the project (a project run from a separate Ultimate clone), nothing is offered: a branch lives in the project's repository and the lander lands into the project, so it cannot merge into the clone. That clone keeps the plain refusal; merge it by hand.

## After a landing

The lander fast-forwards the host's checkout itself, so a landing that changes packages would leave the old ones on disk. On each `workspaces.landed` whose range changes `pnpm-lock.yaml` or `patches/`, and whose commit the clone's `HEAD` holds (the landing went into this clone's checkout), the extension runs the same install under the clone-wide lock, after the lander's checks and outside its timing. A patch-only change counts too: its hash sits in the lockfile's `patchedDependencies`, so the lockfile differs from the installed one. The item then reads `updated · restart`, or `install owed` when the install failed. Nothing restarts by itself; previews never install.

## Events

Each update records a durable event, emitted in its own commit right after the change, because the clone lives outside storage. A crash in between loses the event, not the update.

- `update.applied`: `{ root, from, to, commits, layers, install }`, for an update that moved the clone.
- `update.refused`: `{ root, reason }`.
