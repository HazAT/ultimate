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
React callers outside the transcript (inbox's reading pane, side chat, voice-live, review's surface, sidebar, lineage)
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

**Moves in:** C3 (the composer) or C4 (the shell, palette, boundary and slot hosts) is the step whose host frees the
row. "any (provider)" is a React hook provider no host blocks: it moves whenever its extension does, as
`provide(Point, island(C))` or a plain value.

**Summary (after P2 and P3):** 34 rows (a row is one part or a group of one extension's parts). By core host:

| Core host                                                       | Rows | Extensions |
| --------------------------------------------------------------- | ---- | ---------- |
| The transcript's points and overlays (host done in C2)          | 11   | 10         |
| The sidebar (React rows and sections other extensions provide)  | 3    | 3          |
| Panel and surface hosts, System's tab host, documents' views    | 11   | 8          |
| The composer                                                    | 3    | 3          |
| React points of other extensions (onboarding, the Agents panel) | 6    | 6          |

Transcript renderers still React, which no host blocks (they move with their extension, before C5): dream's four
cards, onboarding's `setup` tool and three cards, plan's `plan` tool, side-chat's summary card, and voice-live's seven
entries and six `() => null` tools (a React root each, to render nothing). `rg -n "(tools|entries|toolLines|
messageActions|messageDetails|answerLabels|userBubble):" extensions/*/web.tsx` lists them.

User extensions outside this repository (`~/.ultimate/extensions`) contribute React renderers too: pr-triage's
`pr-triage.request` entry, shell's `shell` tool and `shell.result` entry. They mount through the bridge unchanged; C5
breaks them unless they move to `island(C)` first.

## The transcript

| Extension     | Part                                                                                            | Where                   | Hook in the transcript       | Moves in       |
| ------------- | ----------------------------------------------------------------------------------------------- | ----------------------- | ---------------------------- | -------------- |
| automations   | provided `WaitTimers` (`useWaitTimers`)                                                         | `automations/web.tsx`   | messages' wait timers        | any (provider) |
| conversations | provided `EmptyTranscript` (`standing.tsx`)                                                     | `conversations/web.tsx` | empty transcript             | C4             |
| codemode      | provided `MessageReference`                                                                     | `codemode/web.tsx`      | message actions              | any (provider) |
| reel          | provided `MessageExtras` (its chip opens the React `Player` dialog with questions' answer card) | `reel/web.tsx`          | message cards, inbox's cards | any (provider) |
| tasks         | provided `RunStart` (a data hook)                                                               | `tasks/web.tsx`         | the run timer                | any (provider) |
| pause         | provided `ParkedRuns` (also read by the sidebar and System)                                     | `pause/web.tsx`         | parked runs                  | C4             |
| subagents     | provided `ErrorReport` (a data hook the React boundary reads)                                   | `subagents/web.tsx`     | error cards                  | C4             |
| review        | provided `workspaces.review` (`Review`) and the `ReviewLink` overlay that takes `review:open`   | `review/web.tsx`        | the sidebar                  | C4             |
| messages      | slot `OffscreenQuestions` (reads the React `useTranscriptScroll` refs to find cards offscreen)  | `messages/web.tsx`      | top                          | C4             |
| messages      | `MessageNavigation` overlay, `OpenMessages` (composer status)                                   | `messages/web.tsx`      | overlay, composer            | C4             |
| questions     | overlay `CrossSurfaceDraftSweep` (no controls)                                                  | `questions/web.tsx`     | overlay                      | C4             |

## The sidebar

| Extension | Part                         | Where              | Notes                   | Moves in |
| --------- | ---------------------------- | ------------------ | ----------------------- | -------- |
| phase     | provided `ConversationPhase` | `phase/web.tsx`    | also read by voice-live | C4       |
| instance  | provided `PreviewUp`         | `instance/web.tsx` | preview marks           | C4       |
| inbox     | provided `UnderUltimate`     | `inbox/web.tsx`    | returns an island       | C4       |

## Panel and surface hosts

| Extension   | Part                                                                                                                    | Where                 | Why it waits                                                    | Moves in |
| ----------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------- | --------------------------------------------------------------- | -------- |
| agent       | the `agent` surface and the title bar's panel buttons                                                                   | `agent/web.tsx`       | is the conversation view: transcript, composer, panels          | C4       |
| documents   | the Documents panel                                                                                                     | `documents/web.tsx`   | hosts other extensions' React document views                    | C4       |
| codemode    | document view `codemode.store`                                                                                          | `codemode/web.tsx`    | a Documents view                                                | C4       |
| subagents   | the Agents panel (`overview.tsx`) and the definition dialog (`definitions.tsx`, `fields.tsx`)                           | `subagents/web.tsx`   | uses models' React family editor (`FamilyPopover`, `AddFamily`) | C4       |
| inbox       | the surface frame (core `Sidebar`, `Header`, the `QuestionPane` takeover)                                               | `inbox/web.tsx`       | the surface host; side-chat's React pane                        | C4       |
| inbox       | the reading pane: messages' `Body`, `MessageImages`, `MessageExtras`, questions' card, items' `pane`                    | `inbox/reading.tsx`   | hosts the transcript's message parts                            | C4       |
| inbox       | the contract `Waiting`, `InboxItems`, `QuestionPane` and the wrappers feeding its islands                               | `inbox/ui.tsx`        | React points other extensions provide                           | C4       |
| wire        | the tab's wrapper, docking the core `Conversation`                                                                      | `wire/web.tsx`        | System's tab host; the core dock                                | C4       |
| wire        | the `wire.open` overlay (`useDialog`, `useOpenWire`)                                                                    | `wire/web.tsx`        | a command cannot set UI state                                   | C4       |
| todos       | the panel's wrapper, reading inbox's React `Waiting` for the Solid list                                                 | `todos/web.tsx`       | inbox's `Waiting` is React                                      | C4       |
| automations | the panel's wrapper, passing `overlayOpen` (phone/tablet panel overlay) and `requested` (the conversation being loaded) | `automations/web.tsx` | the shell's open state and `requested` have no Solid reader     | C4       |

## The composer

| Extension     | Part                                            | Where                   | Moves in |
| ------------- | ----------------------------------------------- | ----------------------- | -------- |
| read-aloud    | composer wrapper `ReadingStrip`                 | `read-aloud/web.tsx`    | C3       |
| subagents     | inbox renderer `AgentInbox` (`inbox.tsx`)       | `subagents/web.tsx`     | C3       |
| conversations | provided `ComposerPlaceholder` (`standing.tsx`) | `conversations/web.tsx` | C3       |

## Other extensions' React points

| Extension   | Part                                                                                                                                                | Where               | Called by                                                           | Moves in       |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------- | -------------- |
| mcp         | provided `ExtensionDetails`                                                                                                                         | `mcp/web.tsx`       | onboarding's React details (returns an island)                      | C4             |
| reel        | provided `LandingExtras`                                                                                                                            | `reel/web.tsx`      | workspaces' Solid landing card, through `Provided`                  | any (provider) |
| side-chat   | provided `CardActions` (`useTalkItThrough`)                                                                                                         | `side-chat/web.tsx` | questions' Solid answer card, through `Provided`                    | any (provider) |
| plan        | provided `LandedNote`                                                                                                                               | `plan/web.tsx`      | workspaces' Solid landing card, through `Provided`                  | any (provider) |
| models      | `FamilyPopover`, `AddFamily`, `moveFeature` (`family-editor.tsx`); `FamilyDot`, `FamilyLabel`, `useFamilies`, `usePicks` (`families.tsx`, `ui.tsx`) | `models/`           | subagents' Agents panel and definition form, onboarding's Get ready | C4             |
| automations | `useAutomations`, `timerWaits` (`ui.tsx`)                                                                                                           | `automations/`      | sidebar, system                                                     | C4             |

## Shared state and keys

- **Whose key.** `useExtensionUiState` takes the extension name of where a part renders. `Provided` and `AllProvided`
  run a provider's hook in the provider's scope but render what it returns (a System tab's `component`, a sidebar row)
  in the host's, so such a part names its own key (`extensions/wire/state.ts`). Giving returned components their
  provider's scope needs `web/src/app/boundary.tsx`, so it belongs to the core switch.
- **Contracts.** Every `ui.tsx` stays React while React code imports it. A Solid part reaches another extension through
  its `refs.ts` or its `ui.solid.tsx`: `conversations`, `workspaces`, `messages`, `plan` and `sidebar` have one. Give
  an extension a `ui.solid.tsx` when a moved part needs one of its components, not ahead of time.
- **`prettyName`.** The core's `web/src/app/titlebar.tsx` keeps its own copy; both SDKs export the one in
  `web/src/sdk/format.ts`, so the switch drops the title bar's.
