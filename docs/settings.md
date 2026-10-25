## Discovery and settings

Discovery is clone built-ins, then `~/.ultimate/`, then `<project>/.ultimate/`; later names replace earlier ones.
Skills ([Agent Skills](https://agentskills.io) folders with a `SKILL.md`, as Pi loads them) come from clone `skills/`, the
project's `.pi/skills/`, `~/.agents/skills/`, `~/.ultimate/skills/`, then, once the project is trusted, its
`.agents/skills/` and `.ultimate/skills/`; a later root overrides an earlier skill of the same name. Both personal
roots are scanned, so distinct skills from both remain available; Ultimate-specific skills win name conflicts.
Collections such as `~/.agents/skills/shared/<name>/SKILL.md` are discovered recursively, stopping at a directory
that contains its own `SKILL.md`. Every agent's
system prompt lists each skill's name, description and path after the project context, and the agent reads `SKILL.md`
when a task matches (`disable-model-invocation: true` leaves a skill out of that list). The user runs one with
`/skill:name request` in the composer or ⌘K → Run a skill: the server sends the skill's body in Pi's `<skill>` block
ahead of the request. The Info tab lists skills with their scope, overrides and Pi's load warnings; a read of a
`SKILL.md` shows as `skill <name>` in the transcript. Personal instructions load from `~/.ultimate/AGENTS.md`
(or `CLAUDE.md`) ahead of the project's. Pi's own `~/.pi/agent/skills/` and `~/.pi/agent/AGENTS.md` are not read;
shared personal skills use `~/.agents/skills/`, while Ultimate-only skills use `~/.ultimate/skills/`.
Built-ins are on by default, including `messages` (durable agent messages and @ultimate's messages to you), `questions` (answer cards for @ultimate's questions to the user), `lineage` (conversation trees: roots, branches, notes) and `update` (tells you when the Ultimate clone is behind `origin`, checked hourly). The ones that need something of their own ship installed but off (`defaultOff` in `shared/extension-api.ts`): `cloud` (backups; your own backup Worker), `parallel` (web tools; a Parallel API key), `tailscale` (remote access; Tailscale on this machine), `health` (provider health, reported with backups), `classify` (Jev typed judgments; a Jev key), `phase` (working phases; requires `classify`) and `sounds` (notification sounds). `recall` (project memories recalled for @ultimate's messages) is on but idle until `classify` is. The first-run extensions card and the Extensions tab turn them on in user settings. Settings layer defaults, `~/.ultimate/settings.json`, then `<project>/.ultimate/settings.json`:
`extensions.enable` and `extensions.disable` are name arrays, later layers win, and changes apply live without a
restart. User/project extension folders are on by default too; `disable` turns off any extension. Unknown names
produce a notice. `summaryModel` (`"provider/id[:thinking]"`, default `openai-codex/gpt-6-luna:medium`; project over user)
picks the model for automatic titles, summaries, reply summaries, tree abstracts and the
triage that decides whether an agent's update wakes @ultimate. Set it in either file or with
the "Summary model…" command, and it applies to the next request. `fastModels` (`["openai-codex/<id>", …]`, or `openai/`; project over
user) runs those models on the priority tier through the `fast` extension, at a higher usage rate. `instance.model`
(`"provider/id"`, project over user, default `openai-codex/gpt-6.1-sol`; `null` turns it off) is the one model every
agent in a preview (`instance start`) runs on, fast tier included; see `extensions/instance/README.md`.
`dream.asleepAfter` (a positive integer, project over user, default 5) is how many landed or applied changes make a
dream that @ultimate's compaction started worth falling asleep into a fresh chapter; see `extensions/dream/README.md`.
Compaction thresholds come from Pi's settings (`~/.pi/agent/settings.json`, then `<project>/.pi/settings.json`,
key `compaction`: `enabled`, `reserveTokens`, `keepRecentTokens`) over Pi Durable's defaults (reserve 16k, keep 20k,
background compaction 32k below the blocking threshold), which suit a ~200k window. `server/harness.ts`
(`compactionOverrides`) sets per-model values by context window: `openai-codex/gpt-6.1-sol`
(500k) and the 1M-window Claude Code models, which keep more recent context and start compacting in the background
earlier. `compaction.modelOverrides` in those settings files, keyed by exact `"provider/modelId"` (fields
`reserveTokens`, `keepRecentTokens`, `backgroundTokens`, `enabled`), replaces them field by field. Pi's settings files
are read when the server starts.
User config is independent of `ULTIMATE_HOME`. This repository's `.ultimate/settings.json` holds its isolate setup,
lander checks and preview model.

A project's `.ultimate/` applies only once it is chosen: its `extensions/`, the project `extensions` settings layer,
`agents/`, and `skills/` load only when the project decision is local. Decisions are kept per project path with Pi's
`ProjectTrustStore` in `~/.ultimate/trust.json`, and a linked git worktree shares its main checkout's; undecided behaves like global and is reported in system info
(`project.decision`). Every `.ultimate/settings.json` key (`defaultSurface`, `isolates`, …) goes through the gated
`host.projectSettings()`; onboarding reads the file only to show what choosing the project would bring. The `onboarding` extension asks once and its Extensions panel changes the choice live. Resources you add to a
project's `.ultimate/` stay unloaded until that project is local; tests seed the decision in their temporary home.
