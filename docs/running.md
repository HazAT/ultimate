## Running the server

- `pnpm install`, then `pnpm start` runs the supervisor on Node 26. It owns the public TCP port and single-instance lock, prints the URL and opens it as a Chrome app window (`http://ultimate.localhost:<port>`, a tab without a Chrome-family browser); `--no-open` or `ULTIMATE_NO_OPEN=1` disables opening.
- Run `pnpm add -g .` once in the clone, then `cd ~/Projects/app && ultimate`. `ultimate [dir] [--port N] [--no-open]` starts in that project, or opens a window of it when it already runs; `pnpm start` in the clone uses the clone as the project.
- Project config belongs in `<project>/.ultimate/`: extensions, agents, skills, and optional `settings.json` (JSON object; `defaultSurface` selects the preferred surface). Discovery is built-in, user `~/.ultimate/`, then project config; later names win. User config is independent of `ULTIMATE_HOME`.
- Server facets can export `actions`, a map of async `(args, ctx)` functions callable from codemode with `ultimate.action(extension, action, args?)` or from the UI by `POST /api/extensions/:name/actions/:action` with `{ args, conversationId? }`, returning `{ result }`. `ctx` has `host`, optional `conversationId`, `signal`, and `exec(command, args, { cwd?, timeout? })`; exec uses the project cwd, no shell, a 1 MiB output cap and a maximum 30 second timeout.
- `pnpm dev` runs the core standalone; the `restart` tool requires `pnpm start`.
- The browser gets a production bundle of `web/` and every enabled `web.tsx` (`server/web.ts`), built by `server/web-build.ts` in a child process into `<home>/web/<id>/` and served precompressed; the bundler's memory goes when that child exits. While a page is open, a change to a bundled source rebuilds it about 150 ms later (a build takes about 2 s) and the page reloads onto the new `system.web.id`, resuming its view and drafts (`web/src/sdk/resume.ts`). With no page open a change only marks the bundle stale, and the next page load builds it. A `web.tsx` that does not build is left out: its loader rejects with the build error, so its error card shows while the rest runs, and a notice names the file; any other build failure keeps the previous bundle and raises a notice. In the server process Vite only loads server facets (`ssrLoadModule`) and watches files: no browser dependency optimizing, no HMR socket.
- Call `restart` after editing `server/` or `shared/`, or after a landing that changed `patches/` or `pnpm-lock.yaml`, never for `web/`, `extensions/`, or `agents/`. `POST /api/restart` accepts the same swap; reconnect to events to observe the new generation. The supervisor type-checks and prepares a new child without storage, then waits for the old harness to close before opening the new one and resuming work. Failed checks/preparation keep the old child serving.
- A crashed child restarts with backoff. After three failed boots the supervisor serves diagnostics and retries on changes in `server/`, `shared/`, or `extensions/`.
- With Tailscale enabled, the server logs its HTTPS URL as `Ultimate: https://… (remote)` when Tailscale registers it (usually after startup), and logs again when it is no longer served; under the supervisor these are core log lines. The interactive dashboard also keeps the current remote URL at its top, with the local URL underneath, and updates it when remote access changes.
- Binds only `127.0.0.1`; `--port` or `ULTIMATE_PORT` overrides selection, otherwise the supervisor chooses the first free port from `4747`.
- `ULTIMATE_HOME` overrides state storage; the default is `~/.ultimate/projects/<basename>-<sha256(projectRoot) first 8 hex>/`. Different projects can run concurrently, each its own dedicated process, so one Ultimate can manage the others (see [One Ultimate or many](../README.md#one-ultimate-or-many)). Never run two storage owners on the same home.
- `ULTIMATE_GENERATION` defaults to `1` and labels the process in system info.
- Pi's models, settings, and auth are shared with `~/.pi/agent`; the `models` extension logs in to providers.
- `pnpm check` checks format/lint/types; `pnpm test` runs the fast in-process tests with temporary homes (about 60 s today), each scripting its model responses on Pi's faux provider (`prepareHarness({ faux })`, test-only); `pnpm test:e2e` runs `test/e2e`, the tests that spawn real supervisors and instances, on a scripted OpenAI-compatible endpoint (`test/e2e/scripted-model.ts`). Test servers find no Tailscale CLI (`TAILSCALE_COMMAND`), so they stay off the tailnet.
- UI and behaviour are verified on a preview: `instance start` runs a clean Ultimate with every agent on `instance.model` (default `openai-codex/gpt-6.1-sol`, fast; its own home; provider logins are read from `~/.pi/agent`, never copied). Its user config is a private copy in `<home>/user/.ultimate` (`ULTIMATE_USER_HOME`), taken at start with links resolved: settings, model families, agents, skills, trust, onboarding and secrets, so a preview's clicks never change the real `~/.ultimate`; user `extensions/` and the Tailscale registry stay shared through links. Seed it by prompting it as a user would, then look with screenshot or browser (the `verify-ui` skill has the checklist). It spends tokens; stop it when done.
- Restart and chapter-switch flows need a supervised scratch server, since a preview runs `server/main.ts` without the
  supervisor and cannot restart. From the checkout under test, with the host's variables cleared (an agent's shell
  inherits the live server's `ULTIMATE_*`), on an empty user home so the real user extensions in `~/.ultimate` do
  not load into it:
  `H=$(mktemp -d); env $(env | grep -o '^ULTIMATE_[A-Z_]*' | sed 's/^/-u /') ULTIMATE_HOME=$H ULTIMATE_USER_HOME=$H/user pnpm start --port 4799 --no-open`.
  The home must be its own: never the project's default home, which is the live server's. Tailscale follows user
  settings, so with it on there the scratch server publishes on its own tailnet port (`https://<machine>:4799`,
  registered under the scratch home) for the user to open remotely, and frees only that port when it stops; the live
  server's address is untouched. Stop it and delete the scratch home when done.
  A state you cannot reach is reported as unverified, never faked by injecting entries.
- `tsconfig.swap.json` is the server-only type-check gate for swaps.
- `tsconfig.json` (server, tests, tooling) references `tsconfig.web.json` (browser: `web/src`, `extensions/**/*.tsx`).
  `pnpm check` type-checks both; with plain `tsc`, run `tsc -b`.
- The standalone server shuts down on SIGINT/SIGTERM; reopening resumes durable work.

## Starting fresh

`pnpm reset [dir] [--dry-run] [--yes]` starts a project's Ultimate from an empty state. It deletes nothing: `state.sqlite`, `trace.sqlite`, parked `state.stale-*` databases (each with its
`-wal`/`-shm`), every later chapter (`chapters/`, `chapters.json`, `pending-chapter.json`), `conversations.json`,
`previews.json` and `supervisor.log` move to
`~/.ultimate/backups/reset-<time>/<home>/`, and it prints that folder and the `mv` that restores it.

- Stop Ultimate first (`systemctl --user stop ultimate`); it refuses while the
  home's `ultimate.lock` or `storage.lock` is held, and holds both while it moves files.
- Kept: settings, secrets, logins, `project.json`, the lander checkout, worktrees and `ultimate/*` branches. It lists
  worktrees with uncommitted changes and branches not merged into the project's HEAD.
- It journals its progress in `<home>/reset.json`: an interrupted reset finishes into the same backup when run again,
  and `ultimate` refuses to start while the journal exists. `pnpm restore` uses the same journal
  (`extensions/cloud/README.md`).

`pnpm restore [name|key]` is its counterpart for cloud backups: it moves the same files into
`~/.ultimate/backups/restore-<time>/<home>/` and installs a backup in their place (see "Cloud backups" in
`extensions/cloud/README.md`).
