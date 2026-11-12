Delegate bounded work to child conversations with `subagent`, configure them from Markdown agent definitions, and run standing agents such as @ultimate.

## The `subagent` tool

- `start {agent, task, background?, fork?, isolate?}` starts a child from a definition and returns its answer
  (foreground) or its id (background). Child ids are conversation ids.
- `message {id, text, steer?}` steers a busy child, or queues a follow-up with `steer: false`.
- `wait {id}` returns the latest answer; `list` shows your children.
- `stop {id}` stops the child's current work and pending reporters, even before its run starts. It lists the paths left
  uncommitted in the child's worktree; nothing is committed or deleted.
- `land {id}` fast-forwards a worktree child's commits into your checkout; `discard {id}` removes its clean, idle
  checkout and keeps its branch. See [workspaces](../workspaces/README.md).

Every child belongs to an independent background anchor: foreground is a waiting style, not ownership, and stopping the
parent does not stop its children. A foreground start, message or wait returns the answer when ready, or yields on
queued steering while the child keeps running; it then returns status text and the child's id, and you message, stop
or wait again. Follow-ups do not wake waits; steering and other children's answers do.

Each start or message creates a reporter that delivers the answer once, including after a restart. Undelivered answers
steer the current run at its next tool-round boundary, or start a run when the parent is idle. Before each request, a
reminder lists running children and inputs waiting to start. Answers say `Returned model: provider/model`, read from
the stored assistant message.

- **No answer.** A turn with no text, or one that stopped as `aborted` or `error`, is not an answer: the parent gets
  `[subagent <id> failed: ended its turn without an answer]` (foreground: `… Message it to continue.`), and nothing
  retries.
- **Provider errors** belong to the [watchdog](../watchdog/README.md): one retry after 60 seconds for temporary errors,
  else a `watchdog.failure` card to the parent. A later answer (a watchdog retry, or someone typing `continue` in the
  child) is delivered as a normal report, once.
- **Answers without a reporter.** The answer to the parent's one-way message, or to its reply to the child's own
  question, is reported too, or an idle parent would never wake.

Children get `subagent` only when their definition lists it in `tools`; each parent owns only its direct children.

### Agents made on the fly

`start {label, task, family? | model?, thinking?, tools?, instructions?, isolate?}` without `agent` makes a child from
the call; nothing is written to disk. It gets a short neutral base (one task, no delegating or pushing, report
evidence) plus `instructions`; the parent's tools or the `tools` subset, never `subagent`; `family`, else the parent's
model; no automatic summaries; and a worktree when it may `edit` or `write`. Read-only means leaving those two out;
bash stays read-only only by instruction, as for `scout`. A family or model the call names must have a login here and
never falls back; the error lists the usable families.

`label`, `family`, `model` and `thinking` also apply over a named `agent`, for example a worker on the review family;
`tools` and `instructions` need `agent` left out. The root's `subagents.runs` document (`RunsDoc`, `{ [childId]:
{ model?, adhoc? } }`) records each start's model and whether it was made on the fly; the sidebar and call card show
`label · model` with a wand for those.

### History forks

`fork: true` gives the child the parent's visible history up to the call, and the task as its first new input.
Everything else (definition, model, tools, isolate) works as for a fresh child. It costs more than a fresh child; the
prompt cache usually covers the shared prefix.

### Isolates

An isolate is where a child's tools run. `isolate: "none"` (the default) uses the parent's directory; `"worktree"` (the
shipped worker's) gets a checkout made from the parent's committed HEAD, owned by the workspaces extension, with the
project's `isolates.worktree.setup` commands (see [workspaces](../workspaces/README.md)). Isolation is by working
directory, not a sandbox: absolute paths can still reach other checkouts, and children are instructed to work only in
their isolate, commit, and never push.

## Definitions

A definition is Markdown with YAML frontmatter (parsed by Pi's `parseFrontmatter`); the body is the instructions. It is
the profile both subagents and automations run with, turned into a child's configuration by `createChild`
(`children.ts`) and `definitionAgent` (`lib/agents.ts`). `lib/agents.ts` reads `agents/` in Ultimate's clone, then
`~/.ultimate/agents/`, then the project's `.ultimate/agents/`; a later file overrides by name. Definitions are reread on
every start, and editing one does not change the build id.

Fields (others are errors):

- `name`, `description`: required.
- `family`: the model family it runs on; the default family runs on the parent's model. Change a family's model in the
  Agents panel.
- `model`: a pin, `provider/id`, a fuzzy id or name, optionally with `:thinking` (Pi's `resolveCliModel`; custom models
  go in Pi's `models.json`). Unknown models are errors; a pin whose provider has no login here is skipped.
- `thinking`: a Pi thinking level; overrides a model suffix.
- `tools`: a YAML list, a subset of the parent's. Omitted: the parent's tools minus `subagent`. `[read, bash,
  subagent]` opts into bounded delegation. A deferred tool named here is loaded for that conversation. Tool lists
  select tools; they are not a shell sandbox.
- `denyTools`: tool names removed from `tools` or the inherited ones; unknown names are ignored.
- `isolate`: `none` or `worktree`. `resident: true` makes it a standing agent.
- `fast`: the priority tier for `openai-codex/` and `openai/` models (see the fast README).
- `summaries: false` turns off automatic titles, summaries, reply activity lines and tree abstracts for its
  conversations; explicit summary calls still work ([conversations](../conversations/README.md)).
- `title`, `icon`, `tint`: a standing agent's display name (its `@name` stays its address; its idle composer reads
  "Message <title>…") and mark, a
  [lucide](https://lucide.dev/icons) icon name and one of `violet`, `blue`, `green`, `amber`, `red`, `pink`, `teal`,
  `grey`.
- `addTools` marks an **overlay** (below).

**Overlays.** A later file with `addTools` (`[]` when it only changes settings) extends the earlier definition of its
name instead of replacing it: its settings override, its `addTools` and `denyTools` join the earlier lists, and its body
is appended under `## User additions` or `## Project additions`. An overlay that sets `tools`, or has no earlier
definition, fails to parse. So `addTools: []` with `title: Atlas` renames @ultimate in one project, and `addTools: []`
with `model` pins one agent, the exception to families. The setup check warns about user or project files that replace
a built-in whole.

**Shipped definitions:** `coordinator` (branches started with the messages extension's `branch`; its behaviour lives
in `agents/coordinator.md`), `scout` (read-only reconnaissance, tiny family), `worker` (fast family, worktree),
`designer` (design family, worktree), `reviewer`, `lander` and `watcher` (owns one script automation).

**Review team.** The shipped `reviewer` reviews alone on the `review` family. Add `reviewer-<name>.md` definitions and
it leads them instead: it starts every one in parallel and returns one merged verdict, like this repository's
`.ultimate/agents/reviewer-*.md`. Leaves need tools within the lead's (`read`, `bash`, `subagent`).

### Editing definitions

The right panel's **Agents** tab (`overview.tsx`) lists every definition under the model family it runs on (each family
line edits its model, thinking and caps in place; see "Model families" in the models README), then those that pin a
model, then invalid files with their errors. A definition's **move** menu puts it on another family. Clicking one, or
New, opens its config view (`definitions.tsx`): description, model, thinking, tools, isolate, standing agent, automatic
summaries, and the instructions with a preview. Save validates as discovery reads and writes nothing when that fails.
Built-ins are never written: saving one writes an override to the project's `.ultimate/agents/` (only once the
project's setup is local) or `~/.ultimate/agents/`; deleting an override restores what it shadowed. Over a definition
an overlay extends, Save writes an overlay holding only what differs; a change an overlay cannot express (removing a
base tool, rewriting the base instructions) is refused. Duplicate starts a new definition from the shown one.

Another extension opens a config view with `events.emit('subagents:open-definition', { name })` (`''` for a new one)
and hears `subagents:definition-closed { name }` when it closes. Codemode's `ultimate.agents()` lists every definition
with its source, path and fields.

## Standing agents

A `resident: true` definition is a standing agent: one ownerless conversation in the project directory (whatever its
`isolate`), pinned in the sidebar's agents group as `@name`. It starts on the default model and the root's thinking
level, then keeps what is chosen in it; a refresh changes model or thinking only where the definition pins them. A
standing agent whose definition is gone is retired, once every definition parses: its conversation stays readable as an
ordinary one.

## Contract

`host.want(SubagentsApi)` (`api.ts`):

- `residents(ctx)` → `{name, description}[]`, read fresh.
- `standing(name, ctx)` creates or returns the standing conversation and reconfigures it from the current definition;
  unknown and non-resident names fail with the available names. The `standing {name}` action does the same.
- `createChild(…)`: used by automations to start a run from a definition.

The `Standing` document (kind `ultimate.standing-agents`, on `ROOT_CONVERSATION_ID`) maps names to conversation ids.
`ultimate.subagents` holds each conversation's children and actions. Each child's `ultimate.metadata` has `label` (the
definition's name) and `title` (its task).

Each conversation configured as an agent emits `subagents.started` (`Started` in `refs.ts`) in its creating commit:
`{ id, agent, model?, thinking?, parent?, kind }`, `kind` `child` (a subagent or automation run), `standing` (a new
standing conversation; refreshes emit none) or `branch` (emitted by lineage).

Actions for the Agents tab:

- `definitions` returns the definitions (without instructions), files that failed to parse, the main conversation's
  model, thinking and tools, the user and project folders, and whether the project's setup is local.
- `definition {name}` returns the one that applies, its source, path and raw file, the scopes with a file of that name,
  and a later file of that name that fails to parse.
- `saveDefinition {name, scope: "project" | "user", frontmatter, instructions, create?}` validates and writes
  atomically (`create` refuses an existing name); `deleteDefinition {name, scope}` removes a user or project file.
- `standing {name}` opens a standing conversation.

## Transcript

- A `subagent` call renders the agent, task, the child's workspace branch and state, whether it works, its plan task
  chip, its answer, and "open #id".
- Instructions to a child and reports from it are stored as `subagents.instruction` and `subagents.report` inputs and
  render as compact cards with the sender and a **Source** button; message bodies show in full.
- Source and Open add a header **Return** button back to where you came from. The core `ultimate:reveal-entry
  {conversationId, entryId, toolCallId?}` web event reveals a row at the top of the view without auto-follow pulling
  it back.
- Queued instructions and reports above the composer show sender, kind, steer or follow-up, a preview, Source and
  cancel.
- Showing a child makes the composer steer, follow up and stop that child; the header leads back to main.

To try it: start an instance, accept its project setup, ask it to delegate a small task to a worker, and use the
card's Open button.
