Inline setup choices, the first-run prerequisites, and the Extensions panel that turns extensions on and off live.

## First run

The first run has only **Get ready**: connect a provider and choose an available model. The model row recommends a
1M+ context window for @ultimate, and names the chosen model's window when it is smaller. ⌘K **Get ready…** opens it
again whatever the recorded state, e.g. on a preview, which shares the user's `~/.ultimate/onboarding.json`; its
Continue starts onboarding once per root, as above. Continue waits for both, starts onboarding with @ultimate through `onDone`, then records `firstRunDone`;
there is no second page. Escape or the close button records completion without changing settings. Closing returns
focus to the composer. An automated browser (`navigator.webdriver`) does not get this dialog.

## Turning it off

The extension is core tier, so `extensions.disable` ignores it. A machine whose user knows Ultimate sets
`"onboarding": false` in `~/.ultimate/settings.json` (user settings only; a project cannot turn it off for its
users). `status` then reports `off: true` and `firstRun: false`: no Get ready, no splash first-run version, no Start
here card, so no `onboarding.start` input and no setup cards, and no "set up git" reminder. An undecided project
setup keeps its **project setup** reminder, since nothing else asks; with onboarding off, clicking it opens the
Extensions panel at the project decision instead of asking @ultimate. The Extensions panel, ⌘K Get ready… and Walk me
through Ultimate still work on demand.

## Onboarding with @ultimate

Continue on Get ready, or **Set up with @ultimate** on the Start here card, calls the user-only action
`start { root?, instructions? }` and opens @ultimate's standing conversation. An omitted root resolves to the shown
conversation's tree, or conversation 1. The optional focus is passed verbatim as instructions. The action submits a
quiet `onboarding.start` input with `{ root, instructions?, facts }`: project name/path, first-run state, undecided
project setup, Git isolation reason (if any), root id and emptiness. Model text names the event, lists those facts
and preserves the instructions. Request id `onboarding:<root>` ensures one input per root; repeated calls return
`{ id }` without sending again: the root conversation's `onboarding.starts` document maps roots to that standing id.

Start here is a card above @ultimate's composer (`survey.tsx`, through the SDK's `composer` renderer) until
onboarding has run for the project's root: `onboarding.starts` names the root, or the root carries memories (a new
chapter's root, set up long ago; `onboarded.ts`). Its one button, **Set up with @ultimate**, calls `start { root }`,
like Get ready's Continue; once that records the root, the card is gone for good. Its × calls the user-only
`dismiss`, which sets `dismissed` on `onboarding.starts` and hides the card for the project on every device; ⌘K
**Get ready…** still starts setup. The History page (the root) takes
no input.

@ultimate greets and first walks the user through how Ultimate works with the `how-ultimate-works` skill
(`skills/how-ultimate-works/SKILL.md`): five short beats, each a message with one question card and a Skip the rest
option, ending with what the project is about and what to do first. That answer is the user's instructions for setup.
The input carries @ultimate's model and context window so the walkthrough can recommend a 1M+ model.

**Walk me through Ultimate** (⌘K) reruns only the walkthrough: the user-only `walkthrough` action submits a
`walkthrough.start` input to @ultimate, every time, and opens its conversation.

Then @ultimate shows only applicable setup cards one at a time and waits for each choice, then reads the project
with the user able to steer. It writes the root's first memories with `remember` (the user's instructions verbatim among them), suggests at most three useful
project-specific agents, extensions or settings, and builds only what the user chooses. The first feature becomes a
coordinator through `branch`. Roots stay read-only while @ultimate handles setup.

## Setup cards

The deferred model tool `setup { card: 'extensions' | 'project' | 'git' }` is offered only to agent definitions that
name `setup`. It returns immediately with the current situation. It does not apply settings or wait on the user;
the agent should wait for an `onboarding.choice` input before continuing.

The tool renderer shows a quiet, transcript-width card:

- **Extensions:** recommended extensions as checkboxes, initially checked unless the user's settings disable them.
  The default-off built-ins (`cloud`, `parallel`, `exa`, `tailscale`, `health`, `classify`, `phase`, `sounds`;
  see [settings](../../docs/settings.md)) start unchecked unless the user's settings enable them, each with one line
  on what it needs (a key, a service, a Worker).
  Core-tier extensions (`ExtensionInfo.core`, such as `subagents`, `messages`, `lineage`, `onboarding` and `documents`)
  stay checked and disabled with "core, always on": the server keeps them enabled whatever the settings say. Dependencies are checked with their extension (`automations` needs
  `subagents`, `phase` needs `classify`).
  Continue applies user-global choices with `applyFirstRun`. Both checked and unchecked choices are saved explicitly;
  project settings can still override user settings.
- **Project:** "Use this project's setup?", chips showing its extensions, settings, agents and skills, and its
  `.ultimate/README.md` behind "What's in it". Use it / Keep global remembers the decision through `decide`.
  The tool refuses this card when there is no project setup or it is already decided.
- **Git:** why isolation is unavailable, and what Git brings. An empty folder gets Set up Git, through the
  workspaces user action `setupGit` (`git init` and an empty first commit). A folder with files gets
  Let @ultimate do it: the choice input asks the agent to write a fitting `.gitignore` and choose the first commit's
  contents without secrets, dependencies or generated output, adding no remote and pushing nothing. The tool refuses
  when the folder is already isolatable.

The browser sends one user-only `choose` operation in the same conversation: `{ card, toolCallId, extensions }`
for extensions, `{ card, toolCallId, local }` for the project, or `{ card, toolCallId, initialize }` for Git (false
hands setup to @ultimate). The server applies the setting and then submits a typed `onboarding.choice` input with data
`{ card, summary, toolCallId }` and model text `Setup choice (<card>): <summary>`.

A stable request id `onboarding-choice:<toolCallId>` deduplicates retries. The server retains the normalized payload
before admission, so even a queued submission prevents a second tab from choosing differently. Calls are serialized
across settings reloads. If applying succeeds but notification fails, the buttons stay available: retrying applies the
same idempotent setting and admits exactly one input. Only the matching typed choice entry settles the original card
as **Chosen: …**, never the current settings or a local success flag. A quiet input card displays the summary.

The status line keeps **project setup** while the project decision is open and **set up git** while isolation is
unavailable, until Start here is dismissed: then both stay quiet, and ⌘K **Get ready…** and the Extensions panel
still reach the decision. Clicking calls `help { card: 'project' | 'git' }`, which submits "Help me decide whether to use this
project's setup." or "Help me set up git for this folder." directly in @ultimate's standing conversation and returns
its id. The browser opens that conversation on the Agent surface. First-run Continue also selects the Agent surface.
The Extensions panel's About this setup routes there too rather than opening a setup dialog.
The Git status is read again whenever the shown conversation finishes a run, including an agent's first Git commit.

## Extensions panel

The right-panel tab (palette **Extensions…**) shows the project decision, a way to change it, Use this project's setup
everywhere, and every extension with its source, deciding layer, README line and switch. Switches save everywhere
(`~/.ultimate/settings.json`) unless you pick this project (when its setup is in use): a project's settings file is
usually committed, so a personal toggle never lands there by default. A core-tier extension's switch stays on and disabled, its deciding layer
reads `core`: the server keeps the core tier enabled whatever the settings say. Failures show on the row; the list
follows system info. Clicking a row opens it in place (open rows are kept in UI state): its tools with their
description's first line, contract summary, what it provides, needs and wants, actions, documents, events, web
contributions, secrets, prompt sections and hooks, and its folder. Empty groups share one dim line.

## Actions

This default-on built-in exports browser actions. Settings choices and completion actions are user-only: agents
cannot apply them through codemode `ultimate.action`.

- `start { root?, instructions? }`: starts the flow above once per root, returning `{ id }`; user-only.
- `walkthrough`: has @ultimate run the walkthrough again, without setup, returning `{ id }`; user-only.
- `help { card: 'project' | 'git' }`: asks @ultimate for setup help through a direct input, returning `{ id }`; user-only.
- `status`: first-run state; project configuration, decision and README; the user's enable/disable lists; and `adds`,
  the project's agents, skills, extension folders, replacements and declared settings, inspected even while undecided.
- `firstRunDone`: records completion in the injected user home's `.ultimate/onboarding.json`.
- `applyFirstRun { extensions, local? }`: maps names to booleans, moving each name to user `extensions.enable` or
  `disable` and removing it from the opposite list. Records completion, then reloads; optional `local` also decides
  the project.
- `decide { local }`: saves the project choice through Pi's `ProjectTrustStore` and reloads extensions/web facets.
  Linked worktrees share their main checkout's choice.
- `choose { card, toolCallId, extensions? | local? | initialize? }`: applies the card's payload and notifies the
  conversation as one retryable operation, as described above. Requires a conversation. Git initialization uses the
  workspaces service behind the user-only `workspaces/setupGit` action.
- `setExtension { name, enabled, scope }`: updates user or project settings, preserving other keys. Project writes
  require a local decision.
- `adoptProjectSetup`: merges project enable/disable lists into user settings.
- `extensions`: discovered names, sources, effective enablement, deciding layers and README first sentences.
- `details { name }`: the extension's contract summary (first api.ts or refs.ts doc sentence), the catalogue APIs it
  provides, declares, needs and wants, and the events its contract files define.

Undecided projects use global configuration. Only a local decision enables project extension folders, settings,
agents and skills. Settings and completion-marker writes use same-directory temporary files and atomic renames,
with two-space JSON and a trailing newline; `settings.ts` holds the writer.
