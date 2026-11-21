# What waits for the core switch

The React parts the Solid migration's batches (0.8 A–C, 0.9 D–F) left in extensions on purpose: each renders inside
the React core or is a React hook the core calls, so it can only move once that core is Solid. Keep it current when a
batch leaves a part React.

**Done: P2's renderers.** Every transcript renderer of messages, questions, review, workspaces, conversations, goal,
pause, self, setup and status-line is `island(C)`; goal, self, setup and status-line are whole. Solid renderers take the
transcript's parts from `@/sdk/parts.solid.tsx` (`Card`, `Fold`, `MessageActions`, `UserView`, `useToolDuration`) and
read another extension's point with its `Provided`, which renders an `island(C)` provider as Solid and a React one through
the bridge; a React host's `Provided` renders an `island(C)` provider as an element. Points meant for `island(C)`
providers take an object input (`MessageAnswers`, `MessageExtras`: `{ message }`; `LandingExtras`: `{ conversation }`).
React callers outside the transcript (inbox's reading pane, side chat, voice-live, review's surface, lineage)
reach the moved parts through `island` wrappers in the owner's `ui.tsx`; voice-live keeps a small React `Bubble` shell
because it passes React prompt and answer nodes into it.

**Done: the transcript host (C2).** `web/src/app/transcript.solid.tsx` and its rows (tool calls, user turns, message
actions, folds, work runs, the live status) are Solid, with its own scroll-to-bottom (`web/src/app/follow.ts`). Its
renderer points keep their framework: a tool, entry, tool-line, message-action, message-detail, answer-label,
user-bubble or compact-summary renderer contributed as `island(C)` renders as Solid directly; any other is React and
mounts through the temporary bridge in `web/src/sdk/react-island*.tsx`, which C5 deletes. The rows below under "The
transcript" were what P2 and P3 moved, each by writing `island(C)` in its `web.tsx`: `rg -n "(tools|entries|toolLines|
messageActions|messageDetails|answerLabels|userBubble):" extensions/*/web.tsx` lists what is left. Points the host reads
(`ParkedRuns`, `RunStart`, `MessageReference`, `FileUpload`, `EmptyTranscript`) and the `transcript.*` slots run their
React providers through the same bridge until C4.

**Done in P3:** the transcript renderers of subagents, context (whole: its slots too), browser, codemode, parallel,
instance, todos, models, prompt, watchdog, recall, wire, read-aloud and automations are `island(C)`. A UI-valued point a
Solid host reads is filled with `provide(Point, island(C))` and rendered with `Provided` from `@/sdk/parts.solid.tsx`
(`ConversationTaskChip`, which plan fills).

**Done in the step-back after P3:** coding-tools (whole: its cards, lines and `Diff`, which context now uses instead of
its copy), lineage's transcript renderers (entries, tool cards, the rewind action and dialog) and voice-live's
`pi.assistant` row are `island(C)`. Each React renderer mounts one React root per row it renders, again on every
conversation switch; these were the most frequent ones.

**Moves in:** C4 (the shell, palette, boundary and slot hosts) is the step whose host frees the
row. "any (provider)" is a React hook provider no host blocks: it moves whenever its extension does, as
`provide(Point, island(C))` or a plain value.

**Done: the composer (C3).** `web/src/app/composer.solid.tsx` is the composer: the kit `Textarea` in the kit `Form`, kit
Buttons for Send, Stop and each queued input's cancel, attachments in `attach.solid.tsx`, one Solid `FileChip` shared with
user turns. Every contribution it hosts goes through `Contribution` or `Contributed` from `web/src/sdk/react-island.solid.tsx`:
`composer` wrappers, `inbox` renderers and the `composer.*` slots render as Solid when contributed as `island(C)`
(`SolidComposerProps`, `SolidInboxProps`) and mount through the bridge otherwise, so an outside React extension keeps
working. `ComposerRedirect` is a Solid context in `@/sdk/solid`. Side chat's frame, read-aloud's strip, onboarding's
Start card, lineage's history banner, workspaces' lander note and subagents' queued-input card moved with it.
`ComposerPlaceholder` (conversations' `standing.tsx`) and `FileUpload` (attachments) are React data hooks the composer
reads with `useProvided`; voice-live's `VoiceDock` wrapper stays React through the bridge until its extension moves.

**Done: the shell (C4a).** `main.solid.tsx` boots `App.solid.tsx` with Solid's `render`; no React component sits above
the surfaces. The title bar, header, status line, sidebar, panels, dock, palette (`palette.solid.tsx`, the kit `Command`
in the kit `Dialog`) and the fixed error stack (`error-stack.solid.tsx`) are Solid, and `keyboard.ts` is a plain
`installShortcuts()`. Surfaces, panels, badges and slots render through `Contribution` and `Slot`, so React ones mount
through the bridge; `RenderedPoint` chains a point's providers through `Contributed` (`EmptyTranscript`). The React
`Header`, `StatusLine`, `Conversation`, `Dock`, `Sidebar` and `Wordmark` in `@/sdk` are islands of the Solid parts
(`web/src/sdk/shell.tsx`), React children reaching them through `island`'s portal; `ErrorCard` in `boundary.tsx` is an
island of the Solid card. The agent surface and its title-bar panel buttons are `island(C)`.

**Done in C4a, the extensions the shell hosts:**

- messages' `OffscreenQuestions`, `MessageNavigation` and `OpenMessages`, questions' draft sweep and review's link
  overlay are `island(C)`. Review's `workspaces.review` point provides a callback with no React hooks.
- Conversations' standing empty state and MCP's extension details are island providers; the Automations panel reads
  the shell's panel and requested conversation state directly in Solid.
- The System and Inbox surfaces, Wire's tab and command overlay, the To-dos and Documents panels and Codemode's Store
  view are Solid. System tabs and document views render through `Contribution`: `island(C)` runs as Solid and React
  still mounts through the bridge. System reads `ParkedRuns` through the bridge; Inbox does the same for waiting items
  and Side chat's optional reading-pane takeover.
- subagents' Agents panel and definition dialog and models' family editor (`FamilyPopover`, `AddFamily`, `FamilyDot`,
  `FamilyLabel`) are Solid; onboarding's Get ready reads `useFamilies` and `usePicks` from models' `ui.tsx`.
- Overlays find their conversation box by `[data-ui="conversation"]` (side chat, voice-live): a React
  `conversation.overlay` item mounts in the bridge's `display: contents` host, so its `parentElement` has no size.
- Review's surface and lineage's surfaces stay React through the bridge; they move with their extensions.

**Summary (after C4a and C4b):** 20 rows. By core host:

| Core host                                                 | Rows | Extensions |
| --------------------------------------------------------- | ---- | ---------- |
| The transcript's points (host done in C2)                 | 6    | 6          |
| The sidebar (React providers bridged into its Solid host) | 8    | 8          |
| The composer (React parts the Solid host mounts)          | 2    | 2          |
| React points of other extensions                          | 3    | 3          |
| React surfaces mounted through the bridge                 | 1    | 2          |

Transcript renderers still React, which no host blocks (they move with their extension, before C5): dream's four
cards, onboarding's `setup` tool and three cards, plan's `plan` tool, side-chat's summary card, and voice-live's seven
entries and six `() => null` tools (a React root each, to render nothing). `rg -n "(tools|entries|toolLines|
messageActions|messageDetails|answerLabels|userBubble):" extensions/*/web.tsx` lists them.

User extensions outside this repository (`~/.ultimate/extensions`) contribute React renderers too: pr-triage's
`pr-triage.request` entry, shell's `shell` tool and `shell.result` entry. They mount through the bridge unchanged; C5
breaks them unless they move to `island(C)` first.

## The transcript

| Extension   | Part                                                                                            | Where                 | Hook in the transcript       | Moves in       |
| ----------- | ----------------------------------------------------------------------------------------------- | --------------------- | ---------------------------- | -------------- |
| automations | provided `WaitTimers` (`useWaitTimers`)                                                         | `automations/web.tsx` | messages' wait timers        | any (provider) |
| codemode    | provided `MessageReference`                                                                     | `codemode/web.tsx`    | message actions              | any (provider) |
| reel        | provided `MessageExtras` (its chip opens the React `Player` dialog with questions' answer card) | `reel/web.tsx`        | message cards, inbox's cards | any (provider) |
| tasks       | provided `RunStart` (a data hook)                                                               | `tasks/web.tsx`       | the run timer                | any (provider) |
| pause       | provided `ParkedRuns` (bridged in the transcript, sidebar and System)                           | `pause/web.tsx`       | parked runs                  | any (provider) |
| subagents   | provided `ErrorReport` (a data hook the Solid error card reads through the bridge)              | `subagents/web.tsx`   | error cards                  | any (provider) |

## The sidebar

The sidebar and its title bar contributions are Solid (C4b). `sidebar.top` uses `Slot` to render contributions
in either framework. The remaining React providers sit behind the bridge until their own extensions move:

| Extension  | Part                                   | Where                | What the Solid host reads                                 |
| ---------- | -------------------------------------- | -------------------- | --------------------------------------------------------- |
| phase      | `ConversationPhase`                    | `phase/web.tsx`      | The phase word and waiting flag, not its React label      |
| plan       | `ConversationTask`, `ConversationEpic` | `plan/web.tsx`       | Task title and epic data; `ConversationTaskChip` is Solid |
| instance   | `PreviewUp`                            | `instance/web.tsx`   | Whether the branch has a running preview                  |
| pause      | `ParkedRuns`                           | `pause/web.tsx`      | Which conversations' runs are parked                      |
| review     | `Review`                               | `review/web.tsx`     | Optional actions for reviews, commits, and edits          |
| side-chat  | `UnderUltimate`, `Unlisted`            | `side-chat/web.tsx`  | Side-chat rows and conversations to exclude               |
| voice-live | `UnderUltimate`, `Unlisted`            | `voice-live/web.tsx` | The Voice row and its conversation to exclude             |
| inbox      | `UnderUltimate`                        | `inbox/web.tsx`      | The Inbox row, returned as an island                      |

## React surfaces

The surface host is Solid (C4a); these React surfaces mount through the bridge and move with their extension.

| Extension       | Part                                                   | Where                 | Moves in             |
| --------------- | ------------------------------------------------------ | --------------------- | -------------------- |
| review, lineage | the Review surface (`surface.tsx`); History and Memory | `review/`, `lineage/` | with their extension |

## The composer

The host is Solid (C3); these React parts mount through the bridge and wait on their own extension's move.

| Extension     | Part                                                    | Where                   | Moves in        |
| ------------- | ------------------------------------------------------- | ----------------------- | --------------- |
| conversations | provided `ComposerPlaceholder` (`standing.tsx`)         | `conversations/web.tsx` | any (provider)  |
| voice-live    | composer wrapper `VoiceDock`, `composer.actions` button | `voice-live/web.tsx`    | with voice-live |

## Other extensions' React points

| Extension | Part                                        | Where               | Called by                                          | Moves in       |
| --------- | ------------------------------------------- | ------------------- | -------------------------------------------------- | -------------- |
| reel      | provided `LandingExtras`                    | `reel/web.tsx`      | workspaces' Solid landing card, through `Provided` | any (provider) |
| side-chat | provided `CardActions` (`useTalkItThrough`) | `side-chat/web.tsx` | questions' Solid answer card, through `Provided`   | any (provider) |
| plan      | provided `LandedNote`                       | `plan/web.tsx`      | workspaces' Solid landing card, through `Provided` | any (provider) |

## Shared state and keys

- **Whose key.** `useExtensionUiState` takes the extension name of where a part renders. A point's hook runs in the
  provider's scope, but a component it returns may render in the host's scope (System's tabs). Wire names its own
  keys explicitly (`extensions/wire/state.ts`).
- **Contracts.** Every `ui.tsx` stays React while React code imports it. A Solid part reaches another extension through
  its `refs.ts` or its `ui.solid.tsx`: `conversations`, `workspaces`, `messages`, `plan` and `sidebar` have one. Give
  an extension a `ui.solid.tsx` when a moved part needs one of its components, not ahead of time.
