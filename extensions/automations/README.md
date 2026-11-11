Durable schedules, domain events, context thresholds and supervised scripts, with actions that start prompt runs or wake subscribed conversations. One `automation` tool and session ledger; requires core `subagents` and `messages`. Scripts use tokens for setup and repair, not waiting; prompt runs cost tokens on every fire.

## Triggers

Exactly one per automation:

- **Schedule.** `cron "0 9 * * 1-5" Europe/Vienna`: five fields (minute, hour, day of month, month, weekday) with
  numbers, lists, ranges and steps; Sunday is 0 or 7; the timezone defaults to the machine's. `at
  2026-12-01T09:00:00Z` or `in 30m` / `2h` / `1d` fires once, then disables (prefer explicit ISO offsets). `every 15m`
  is an elapsed interval of at least one second (units s, m, h, d). Overdue fires run once after a restart; an
  overlapping prompt run is recorded as skipped. Editing other fields keeps the next fire time; resuming a spent
  one-shot is refused until its time is updated.
- **Event.** `event: {name, where?}` fires for matching domain events after creation or resume. `automation events`
  lists the supported names and filter fields. `where` compares top-level data with strict equality; a value `@name`
  stands for that standing agent's conversation when the event comes, so `conversations.compacted where
  conversation=@ultimate` follows @ultimate across chapters. Events from the automation's own prompt runs are ignored.
- **Context.** `condition: {metric: 'context', of: '@name' | '#id', above: 80, cooldownMs?: 3600000, idleFor?}` fires
  when the conversation's context crosses `above`, then re-arms only after it drops below `above - 10`. The cooldown
  counts from the condition's own last crossing, not manual runs. With `idleFor` (ms) it also waits until the user gave
  `of` no input for that long (`idleFor: 0` on update removes it). Dream ships two of these on `@ultimate`
  (`extensions/dream/README.md`).
- **Script.** `ask` instead of a schedule: a `watcher` agent writes an executable `run`, tests it by hand until one
  check succeeds and calls `automation resume {id}`. Stdout `FIRE [text]` fires; stderr and other stdout are progress. `once` (default true)
  makes the first FIRE finish the automation. A recurring script may print `DONE [text]` and exit 0 to stop cleanly.
  Any other unplanned exit wakes only the watcher, to repair or escalate. The third failure in a row (a FIRE or an hour
  of running resets the count), or a watcher whose turn ends mid-repair, escalates instead: the script stops as
  `failed`, subscribers get `automations.escalated`, and @ultimate a message.

## Actions

Each automation has one or both:

- `prompt` starts a fresh run conversation per fire, labelled `automation`, titled with the name and local fire time; a
  nonempty FIRE text is appended as `\n\nFired: <text>`. Runs record status and the first answer line; the ledger keeps
  the last 50 per automation.
- `subscribers` wakes existing conversations with an `automations.fired` input `{id, name, text}`. A subscriber is
  `#12` or a standing agent's `@name`, resolved at delivery, so `@ultimate` follows it across chapters.

Without either, create subscribes the caller; nothing may leave an automation with neither. To be reminded, subscribe:
a prompt run costs a whole agent turn per fire. The seventh fire within an hour pauses the automation instead,
escalating with `Fired more than 6 times in an hour; paused`.

An optional `agent` runs prompt runs with that definition's instructions, tools (minus `automation` and `subagent`),
model and thinking, discovered as in subagents; its isolate is ignored and unknown names are refused. Without one, runs
copy the root agent minus the automation tool, on the default model. `model {provider, modelId}` and `thinking`
override either. Enabled automations add a line each to the prompt, such as `when @ultimate context ≥ 80%`.

## Tool

`automation` is replay-safe and takes `events`, `list`, `create`, `update`, `pause`, `resume`, `run`, `runs`, `log`,
`abort`, `escalate`, `subscribe`, `unsubscribe`, `delete`.

- `create {name, schedule?|ask?|event?|condition?, once?, secrets?, prompt?, agent?, model?, thinking?, subscribers?,
  scope?, slug?, to?, key?}`. `key` makes it idempotent: a key an automation already has returns that automation.
  New ids are `A<n>`; project scripts use slugs.
- `update {id, …}` may switch between schedule, event and condition; a script stays a script.
- `pause` / `resume`; `run` fires now, or relaunches a script; `runs {id}`; `abort {id, runId}`; `log {id, lines?}`
  (default 50, at most 2000); `subscribe` / `unsubscribe {id, to?}` (default the caller); `escalate {id, reason}`;
  `delete` keeps files and conversations.

Lifecycle events: `automations.started`, `.fired` `{id, text, fire}`, `.done`, `.exited`, `.escalated`.

## Script files

User scripts live in `~/.ultimate/automations/<project>/<id>/`: executable `run`, persistent `state/`, `output.log`
(about 2000 lines / 256 KiB) and `pid`. A user script starts in this folder, not in a repository, so it passes the
repository or path explicitly (`gh --repo`, `git -C`, absolute paths). Ids restart in every chapter, so a chapter after
the first keeps its scripts in `<project>@<chapter>/<id>/` instead; the first chapter's folders stay where they were,
and switching chapters never shares a folder. Scripts get `AUTOMATION_ID` and `AUTOMATION_STATE`, plus only the named
`secrets` from Secrets; records never hold their values. Script state must survive a restart: open stops leftover
processes and relaunches enabled running scripts.

### Project automations

Commit shared scripts as:

```text
<project>/.ultimate/automations/<slug>/
  run                 executable, committed
  automation.json     {"name":"…","ask":"…","once":false,"secrets":["GH_TOKEN"]}
```

`ask` is required; `name` defaults to its first 80 characters, `once` to true, `to` (the standing agent woken on every
machine) to `@ultimate`. Slugs match `^[a-z][a-z0-9-]*$`, at most 63 characters. Runtime state stays machine-local.
Discovery runs only in a project chosen as local: a new manifest becomes a stopped record with an idle watcher, never
starting itself; changed manifests update it; a removed folder or revoked trust forgets it. `delete` forgets the record,
not the folder. `run` executes from the host checkout; a watcher's repairs edit the committed file, and a branch's
edits apply after landing.

## Service and browser API

`AutomationsApi` (`api.ts`, token `automations`, used with `want`) offers `create(args)` (`subscribers` stand in for a
caller; `key` makes it safe to retry), `delete`, `resume`, `pause`, `run` and `status`, each returning the record with
`alive`. Mutating methods commit: call them outside transactions, and from a reactor do not await them.

`POST /api/extensions/automations/actions/<operation>` with `{args}` returns `{result}` for every tool operation, plus
`describe {schedule}` → `{schedule, description, next}` (up to three fire times) and `script {id}` → `{path, text}`
(first 64 KiB). `list`, `log` and `script` are poll actions. Session state is read through `list` and `runs`, not
exported as a document.

## UI

States share one word and colour (`parts.tsx` `lookOf`), worst first: failed (red), investigating (yellow), writing or
working (purple), watching or scheduled (green), paused and done (grey).

- **Automations tab** (right panel, after Activity; palette "Automations…"): every automation, worst first, with its
  trigger in words, state line, what a fire does, an enable switch, Run now or Restart, Edit and Delete. A script's
  "script" opens its watcher beside the script detail (pid, uptime, exit, fires, live output or source). Expanding a
  row lists its runs. The panel follows the shown conversation: a watcher shows its script.
- **Sidebar** (`sidebar.top`): up to five active automations, hidden when none; **status-line chip**: the active count
  in the worst colour. Both open the panel.
- **Transcript:** the `automation` call and the inputs `automations.fired`, `.failed`, `.escalated`, `.writing` render
  as folding cards.
- **Form:** New asks the trigger first. "When something happens" takes the ask in plain words, keep-watching, "Wake
  this conversation" (on by default) and an optional prompt; "On a schedule" takes name, prompt and a preset or raw
  schedule with a live preview from `describe`. The agent picker's Configure opens the definition over the bus
  (`subagents:open-definition`, then `subagents:definition-closed`).
