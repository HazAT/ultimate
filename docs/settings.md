## Discovery and settings

Discovery is clone built-ins, then `~/.ultimate/`, then `<project>/.ultimate/`; later names replace earlier ones.
Enabled extensions may ship `agents/` definitions, loaded as built-ins before user and project definitions or overlays.
Disabling the extension removes its definitions too.
Skills ([Agent Skills](https://agentskills.io) folders with a `SKILL.md`, as Pi loads them) come from clone `skills/`, the
project's `.pi/skills/`, `~/.ultimate/skills/`, then, once the project is trusted, its `.agents/skills/` and
`.ultimate/skills/`; a later scope overrides an earlier skill of the same name. Every agent's
system prompt lists each skill's name, description and path after the project context, and the agent reads `SKILL.md`
when a task matches (`disable-model-invocation: true` leaves a skill out of that list). The user runs one with
`/skill:name request` in the composer or ⌘K → Run a skill: the server sends the skill's body in Pi's `<skill>` block
ahead of the request. The Info tab lists skills with their scope, overrides and Pi's load warnings; a read of a
`SKILL.md` shows as `skill <name>` in the transcript. Personal instructions load from `~/.ultimate/AGENTS.md`
(or `CLAUDE.md`) ahead of the project's. Pi's own `~/.pi/agent/skills/` and `~/.pi/agent/AGENTS.md` and the shared
`~/.agents/skills/` are not read: they belong to other agents, so link a skill into `~/.ultimate/skills/` to use it here.
Built-ins are on by default, including `messages` (durable agent messages and @ultimate's messages to you), `questions` (answer cards for @ultimate's questions to the user), `lineage` (conversation trees: roots, branches, notes) and `update` (tells you when the Ultimate clone is behind `origin`, checked hourly). The ones that need something of their own ship installed but off (`defaultOff` in `shared/extension-api.ts`): `cloud` (backups; your own backup Worker), `parallel` (web tools; a Parallel API key), `tailscale` (remote access; Tailscale on this machine), `health` (provider health), `classify` (Jev typed judgments; a Jev key), `phase` (working phases; requires `classify`), `sounds` (notification sounds) and `voice-live` (live voice relay; an OpenAI API key and microphone). `recall` (project memories recalled for @ultimate's messages) is on but idle until `classify` is. The first-run extensions card and the Extensions tab turn them on in user settings. Settings layer defaults, `~/.ultimate/settings.json`, then `<project>/.ultimate/settings.json`:
`extensions.enable` and `extensions.disable` are name arrays, later layers win, and changes apply live without a
restart. User/project extension folders are on by default too; `disable` turns off any extension outside the core
tier, while a core-tier name (`onboarding`, `subagents`, `lineage`, …) is ignored with a notice. Unknown names
produce a notice. To skip onboarding on a machine whose user knows Ultimate, set `"onboarding": false` in
`~/.ultimate/settings.json` (user settings only): no Get ready, no Start here, no setup cards and no "set up git"
reminder, while the Extensions panel and ⌘K Get ready… stay available and an undecided project setup keeps its
status-line reminder. Model families (⌘K Model families…, `extensions/models/README.md`) are kept per project in
`~/.ultimate/model-families.json`, with the most recently saved ones as the start for projects without their own; a
project's `.ultimate/settings.json` `modelFamilies` applies over them. `summaryModel` (`"provider/id[:thinking]"`; project over user; without it the
summaries family's model, by default the tiny family's `openai-codex/gpt-6-luna:low`)
pins the model for automatic titles, summaries, reply summaries and tree abstracts. Set it in either file or with
the "Summary model…" command, and it applies to the next request. `fastModels` (`["openai-codex/<id>", …]`, or `openai/`; project over
user) runs those models on the priority tier through the `fast` extension, at a higher usage rate. `instance.model`
(`"provider/id"`, project over user, default the previews family's model, the fast family's `openai-codex/gpt-6.1-sol`; `null` turns it off) is the one model every
agent in a preview (`instance start`) runs on, fast tier included; see `extensions/instance/README.md`.
`remotes` (user settings only, `{ "<machine>": { "<project>": "<url>" } }`) names other machines' Ultimate instances,
for example `{ "laptop": { "my-app": "https://laptop.tail1234.ts.net:4747" } }`: codemode's `{ project }` reads and
`ultimate.tell` reach a project on another machine at that URL (its Tailscale Serve address; the caller's tailnet login
must be in its `tailscale.allow`). A project running on this machine answers here first unless another machine is
named; a project listed on several machines needs a `machine`. Cloud backups' register is asked only for projects
`remotes` does not name (`lib/remote.ts`).
Compaction thresholds come from Pi's settings (`~/.pi/agent/settings.json`, then `<project>/.pi/settings.json`,
key `compaction`: `enabled`, `reserveTokens`, `keepRecentTokens`) over Pi Durable's defaults (reserve 16k, keep 20k,
background compaction 32k below the blocking threshold), which suit a ~200k window. `server/harness.ts`
(`compactionOverrides`) sets per-model values by context window: `openai-codex/gpt-6.1-sol`
(500k) and the 1M-window Claude Code models, which keep more recent context and start compacting in the background
earlier. `compaction.modelOverrides` in those settings files, keyed by exact `"provider/modelId"` (fields
`reserveTokens`, `keepRecentTokens`, `backgroundTokens`, `enabled`), replaces them field by field. Pi's settings files
are read when the server starts.
User config is independent of `ULTIMATE_HOME`. A project's `isolates.worktree` sets its checkouts' `setup` commands and, optionally, where they live (`path`) and
how they are made and removed (`add`, `remove`); see `extensions/workspaces/README.md`.
This repository's `.ultimate/settings.json` holds its isolate setup,
lander checks and preview model.

A project's `.ultimate/` applies only once it is chosen: its `extensions/`, the project `extensions` settings layer,
`agents/`, and `skills/` load only when the project decision is local. Decisions are kept per project path with Pi's
`ProjectTrustStore` in `~/.ultimate/trust.json`, and a linked git worktree shares its main checkout's; undecided behaves like global and is reported in system info
(`project.decision`). Every `.ultimate/settings.json` key (`defaultSurface`, `isolates`, …) goes through the gated
`host.projectSettings()`; onboarding reads the file only to show what choosing the project would bring. The `onboarding` extension asks once and its Extensions panel changes the choice live. Resources you add to a
project's `.ultimate/` stay unloaded until that project is local; tests seed the decision in their temporary home.
