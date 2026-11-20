# What waits for the core switch

The React parts that the Solid migration's batches (0.8 A, B and C) left in extensions on purpose: each renders inside
the React core (the transcript, the composer, the panel and surface hosts) or is a React hook the core calls, so it
can only move once that core is Solid. This is the input for planning the core switch; nothing here has moved.

Line numbers are those of each `web.tsx` at the 0.8 step-back.

## Transcript

| Extension   | Part                                                                   | Where                               | Rendered by                    |
| ----------- | ---------------------------------------------------------------------- | ----------------------------------- | ------------------------------ |
| browser     | tool renderers `screenshot`, `browser`                                 | `extensions/browser/web.tsx:238`    | the transcript's tool calls    |
| codemode    | tool renderer `codemode`                                               | `extensions/codemode/web.tsx:254`   | the transcript's tool calls    |
| codemode    | tool line `codemode`                                                   | `extensions/codemode/web.tsx:255`   | the transcript's compact lines |
| instance    | tool renderer `instance`                                               | `extensions/instance/web.tsx:272`   | the transcript's tool calls    |
| instance    | `link` (preview links in messages)                                     | `extensions/instance/web.tsx:273`   | the transcript's Markdown      |
| self        | tool renderer `restart`                                                | `extensions/self/web.tsx:83`        | the transcript's tool calls    |
| todos       | tool renderer `todo`                                                   | `extensions/todos/web.tsx:15`       | the transcript's tool calls    |
| todos       | entry `todos.note` (model-only, renders nothing)                       | `extensions/todos/web.tsx:16`       | the transcript's entries       |
| watchdog    | entry `watchdog.failure`                                               | `extensions/watchdog/web.tsx:8`     | the transcript's entries       |
| prompt      | entry `prompt.build`                                                   | `extensions/prompt/web.tsx:65`      | the transcript's entries       |
| setup       | entry `setup.note` (model-only)                                        | `extensions/setup/web.tsx:8`        | the transcript's entries       |
| recall      | entry of recalled memories (model-only)                                | `extensions/recall/web.tsx:92`      | the transcript's entries       |
| recall      | user bubble `RecallBubble`                                             | `extensions/recall/web.tsx:91`      | the transcript's user message  |
| pause       | entries `pause.note`, `pause.limit`, `pause.autoplay`, `pause.held`    | `extensions/pause/web.tsx:194`      | the transcript's entries       |
| diagrams    | code block `mermaid`                                                   | `extensions/diagrams/web.tsx:16`    | the transcript's Markdown      |
| read-aloud  | message action                                                         | `extensions/read-aloud/web.tsx:146` | the transcript's message bar   |
| status-line | message detail `MessageUsage`                                          | `extensions/status-line/web.tsx:97` | the transcript's message bar   |
| parallel    | tool renderers `web_search`, `web_fetch`                               | `extensions/parallel/web.tsx:393`   | the transcript's tool calls    |
| context     | transcript slots `Start`, `PinnedPrompt` (reads `useTranscriptScroll`) | `extensions/context/web.tsx:147`    | the transcript's start and top |
| context     | entries `pi.system`, `pi.reset`, `pi.compaction`, `pi.assistant`       | `extensions/context/web.tsx:148`    | the transcript's entries       |
| context     | point `CacheRebuiltLine` (`<Rendered>` with React `core`)              | `extensions/context/ui.tsx:9`       | the transcript's entries       |
| wire        | entry `pi.assistant` (`WireLink`)                                      | `extensions/wire/web.tsx`           | the transcript's entries       |

## Composer, panels and surfaces

| Extension  | Part                                                                                                                        | Where                               | Rendered by                                            |
| ---------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------ |
| read-aloud | composer wrapper `ReadingStrip`                                                                                             | `extensions/read-aloud/web.tsx:147` | the composer                                           |
| codemode   | document view `codemode.store`                                                                                              | `extensions/codemode/web.tsx:256`   | the Documents panel                                    |
| documents  | the Documents panel                                                                                                         | `extensions/documents/web.tsx:127`  | hosts other extensions' React document views           |
| agent      | the `agent` surface and the title bar's panel buttons                                                                       | `extensions/agent/web.tsx:67`       | is the conversation view: transcript, composer, panels |
| todos      | the panel's React wrapper (`Todos`), reading inbox's React `Waiting` point for the Solid list                               | `extensions/todos/web.tsx:10`       | inbox's `Waiting` is React                             |
| inbox      | the surface frame (`Surface`: core `Sidebar`, `Header`, the `QuestionPane` takeover)                                        | `extensions/inbox/web.tsx:35`       | the surface host; side-chat's React pane               |
| inbox      | the reading pane (`Reading`): messages' `Body`, `MessageImages`, `MessageExtras`, questions' card, a provided item's `pane` | `extensions/inbox/reading.tsx:12`   | hosts other extensions' React                          |
| inbox      | the contract `Waiting`, `InboxItems`, `QuestionPane` and the wrappers feeding its islands                                   | `extensions/inbox/ui.tsx`           | React points other extensions provide                  |
| wire       | the `wire.open` overlay `OpenOnCommand` (React `useDialog`, `useOpenWire`)                                                  | `extensions/wire/web.tsx`           | a command's context cannot set UI state                |
| wire       | the tab's React wrapper, docking the core `Conversation`                                                                    | `extensions/wire/web.tsx`           | System's tab host; the core dock                       |

## Hooks the core calls (`provide`)

A provided value is a React hook the core or another React extension calls during its render.

| Extension | Point               | Where                             | Called by                                                                        |
| --------- | ------------------- | --------------------------------- | -------------------------------------------------------------------------------- |
| phase     | `ConversationPhase` | `extensions/phase/web.tsx:17`     | the React sidebar's rows, voice-live                                             |
| codemode  | `MessageReference`  | `extensions/codemode/web.tsx:253` | the transcript's message actions                                                 |
| instance  | `PreviewUp`         | `extensions/instance/web.tsx:267` | the React sidebar's preview marks                                                |
| pause     | `ParkedRuns`        | `extensions/pause/web.tsx:186`    | the transcript, the React sidebar, system                                        |
| mcp       | `ExtensionDetails`  | `extensions/mcp/web.tsx:10`       | onboarding's React details (returns an island)                                   |
| reel      | `MessageExtras`     | `extensions/reel/web.tsx:126`     | messages' and inbox's React cards; its player shows questions' React answer card |
| reel      | `LandingExtras`     | `extensions/reel/web.tsx:138`     | workspaces' React landing card                                                   |
| inbox     | `UnderUltimate`     | `extensions/inbox/web.tsx:85`     | the React sidebar (returns an island)                                            |

## Contracts that stay React until then

Every `ui.tsx` stays React while React code imports it. A Solid part reaches another extension through its `refs.ts`,
or through a `ui.solid.tsx` once that extension has one: `conversations` does (`ConversationRef`), so `pause` and
`self` dropped their React or copied references. Give an extension a `ui.solid.tsx` when a moved part needs one of its
components, not ahead of time.

`sidebar` has one since 0.9 E (`ProjectSwatch`, `RepoLabel` for the projects rail), sharing `colour.ts` with its React
`tile.tsx`. The core's `web/src/app/titlebar.tsx` keeps its own `prettyName`; both SDKs export the one in
`web/src/sdk/format.ts`, so the switch drops the title bar's copy.
