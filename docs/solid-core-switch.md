# What waits for the core switch

The React parts the Solid migration's batches (0.8 A–C, 0.9 D–F) left in extensions on purpose: each renders inside
the React core or is a React hook the core calls, so it can only move once that core is Solid. This is the input for
planning the core switch; nothing here has moved. Keep it current when a batch leaves a part React.

**Summary (C1):** 51 rows (a row is one part or a group of one extension's parts) in 29 extensions. By
core host:

| Core host                                                               | Rows | Extensions |
| ----------------------------------------------------------------------- | ---- | ---------- |
| The transcript (tool and entry renderers, message bar, bubble)          | 31   | 24         |
| The sidebar (React rows and sections other extensions provide)          | 3    | 3          |
| Panel and surface hosts, System's tab host, documents' views            | 10   | 7          |
| The composer                                                            | 2    | 2          |
| React points of other extensions (onboarding, workspaces' landing card) | 5    | 5          |

The transcript blocks the most: two thirds of the rows, and it hosts most of the rest indirectly (inbox's reading pane
and the landing card render its message parts). Switch it first.

## The transcript

| Extension     | Part                                                                                               | Where                       | Hook in the transcript       |
| ------------- | -------------------------------------------------------------------------------------------------- | --------------------------- | ---------------------------- |
| browser       | tool renderers `screenshot`, `browser`                                                             | `browser/web.tsx`           | tool calls                   |
| codemode      | tool renderer and compact line `codemode`                                                          | `codemode/web.tsx`          | tool calls, compact lines    |
| goal          | tool renderer `goal` (`call.tsx`)                                                                  | `goal/web.tsx`              | tool calls                   |
| instance      | tool renderer `instance`                                                                           | `instance/web.tsx`          | tool calls                   |
| parallel      | tool renderers `web_search`, `web_fetch`                                                           | `parallel/web.tsx`          | tool calls                   |
| self          | tool renderer `restart`                                                                            | `self/web.tsx`              | tool calls                   |
| todos         | tool renderer `todo`                                                                               | `todos/web.tsx`             | tool calls                   |
| workspaces    | tool renderer `workspace`; entries `lineage.note` (landing card), `ultimate.lander`, lander report | `workspaces/web.tsx`        | tool calls, entries          |
| context       | entries `pi.system`, `pi.reset`, `pi.compaction`, `pi.assistant`; point `CacheRebuiltLine`         | `context/web.tsx`, `ui.tsx` | entries                      |
| context       | slots `Start`, `PinnedPrompt` (read `useTranscriptScroll`)                                         | `context/web.tsx`           | start and top                |
| goal          | entries `goal.started`, `goal.report` (with End hands-off), `goal.note` (model-only)               | `goal/cards.tsx`            | entries                      |
| pause         | entries `pause.note`, `pause.limit`, `pause.autoplay`, `pause.held`                                | `pause/web.tsx`             | entries                      |
| prompt        | entry `prompt.build`                                                                               | `prompt/web.tsx`            | entries                      |
| recall        | entry of recalled memories (model-only); user bubble `RecallBubble`                                | `recall/web.tsx`            | entries, user message        |
| setup         | entry `setup.note` (model-only)                                                                    | `setup/web.tsx`             | entries                      |
| todos         | entry `todos.note` (model-only)                                                                    | `todos/web.tsx`             | entries                      |
| watchdog      | entry `watchdog.failure`                                                                           | `watchdog/web.tsx`          | entries                      |
| models        | entries `pi.assistant` (model switch divider `Switched`), `models.fallback` (`FellBack`)           | `models/web.tsx`            | entries                      |
| automations   | tool renderer `automation`; entries `automations.fired`, `.failed`, `.escalated`, `.writing`       | `automations/web.tsx`       | tool calls, entries          |
| automations   | provided `WaitTimers` (`useWaitTimers`)                                                            | `automations/web.tsx`       | messages' wait timers        |
| conversations | entries `conversations.*` (`SummaryAction`)                                                        | `conversations/web.tsx`     | entries                      |
| conversations | provided `EmptyTranscript` (`standing.tsx`)                                                        | `conversations/web.tsx`     | empty transcript             |
| wire          | entry `pi.assistant` (`WireLink`)                                                                  | `wire/web.tsx`              | entries                      |
| read-aloud    | message action                                                                                     | `read-aloud/web.tsx`        | message bar                  |
| status-line   | message detail `MessageUsage`                                                                      | `status-line/web.tsx`       | message bar                  |
| codemode      | provided `MessageReference`                                                                        | `codemode/web.tsx`          | message actions              |
| reel          | provided `MessageExtras` (its player shows questions' React answer card)                           | `reel/web.tsx`              | message cards, inbox's cards |
| questions     | provided `MessageAnswers`; the answer card agents cannot press yet                                 | `questions/web.tsx`         | message cards, inbox's cards |
| tasks         | provided `RunStart`                                                                                | `tasks/web.tsx`             | the run timer                |
| pause         | provided `ParkedRuns` (also read by the sidebar and System)                                        | `pause/web.tsx`             | parked runs                  |
| review        | provided `workspaces.review` (`Review`) and the `ReviewLink` overlay that takes `review:open`      | `review/web.tsx`            | the landing card, sidebar    |

## The sidebar

| Extension | Part                         | Where              | Notes                   |
| --------- | ---------------------------- | ------------------ | ----------------------- |
| phase     | provided `ConversationPhase` | `phase/web.tsx`    | also read by voice-live |
| instance  | provided `PreviewUp`         | `instance/web.tsx` | preview marks           |
| inbox     | provided `UnderUltimate`     | `inbox/web.tsx`    | returns an island       |

## Panel and surface hosts

| Extension   | Part                                                                                                                    | Where                 | Why it waits                                                |
| ----------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------- | ----------------------------------------------------------- |
| agent       | the `agent` surface and the title bar's panel buttons                                                                   | `agent/web.tsx`       | is the conversation view: transcript, composer, panels      |
| documents   | the Documents panel                                                                                                     | `documents/web.tsx`   | hosts other extensions' React document views                |
| codemode    | document view `codemode.store`                                                                                          | `codemode/web.tsx`    | a Documents view                                            |
| inbox       | the surface frame (core `Sidebar`, `Header`, the `QuestionPane` takeover)                                               | `inbox/web.tsx`       | the surface host; side-chat's React pane                    |
| inbox       | the reading pane: messages' `Body`, `MessageImages`, `MessageExtras`, questions' card, items' `pane`                    | `inbox/reading.tsx`   | hosts the transcript's message parts                        |
| inbox       | the contract `Waiting`, `InboxItems`, `QuestionPane` and the wrappers feeding its islands                               | `inbox/ui.tsx`        | React points other extensions provide                       |
| wire        | the tab's wrapper, docking the core `Conversation`                                                                      | `wire/web.tsx`        | System's tab host; the core dock                            |
| wire        | the `wire.open` overlay (`useDialog`, `useOpenWire`)                                                                    | `wire/web.tsx`        | a command cannot set UI state                               |
| todos       | the panel's wrapper, reading inbox's React `Waiting` for the Solid list                                                 | `todos/web.tsx`       | inbox's `Waiting` is React                                  |
| automations | the panel's wrapper, passing `overlayOpen` (phone/tablet panel overlay) and `requested` (the conversation being loaded) | `automations/web.tsx` | the shell's open state and `requested` have no Solid reader |

## The composer

| Extension     | Part                                            | Where                   |
| ------------- | ----------------------------------------------- | ----------------------- |
| read-aloud    | composer wrapper `ReadingStrip`                 | `read-aloud/web.tsx`    |
| conversations | provided `ComposerPlaceholder` (`standing.tsx`) | `conversations/web.tsx` |

## Other extensions' React points

| Extension   | Part                                                                                                                                                | Where                    | Called by                                                           |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------- |
| mcp         | provided `ExtensionDetails`                                                                                                                         | `mcp/web.tsx`            | onboarding's React details (returns an island)                      |
| reel        | provided `LandingExtras`                                                                                                                            | `reel/web.tsx`           | workspaces' React landing card                                      |
| workspaces  | `CommitCount`, `LandingCard` (React)                                                                                                                | `workspaces/landing.tsx` | the landing card in the transcript                                  |
| models      | `FamilyPopover`, `AddFamily`, `moveFeature` (`family-editor.tsx`); `FamilyDot`, `FamilyLabel`, `useFamilies`, `usePicks` (`families.tsx`, `ui.tsx`) | `models/`                | subagents' Agents panel and definition form, onboarding's Get ready |
| automations | `useAutomations`, `timerWaits` (`ui.tsx`); `Dot`, `useOpenAutomation` (`parts.tsx`) for its own entries                                             | `automations/`           | sidebar, system, its transcript entries                             |

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
