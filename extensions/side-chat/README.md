Side chats are temporary, ownerless copies of the standing @ultimate conversation. The user opens one to explore a tangent, then discards it or sends a summary back without waking main. A side chat keeps its fixed `Side chat` title: `open` turns its automatic summaries off (`setAutomaticSummaries` on the conversations service), so no intent, reply or spawn trigger asks the summary model; only Summarize & inject does.

## UI (`web.tsx`)

- **Tab** in @ultimate's composer toggles side chat mode (`togglesSideMode`, `logic.ts`): a bare Tab, not while a popup owns it, never in a side chat's composer (one level only); Shift+Tab stays the thinking level. A Normal / Side chat switch above the composer shows the mode and toggles it by click; the prompt turns dashed brand and its placeholder says main keeps running. Enter sends through the core's `ComposerRedirect` to `open`, then the new side chat comes to the front and the mode returns to normal.
- **Depth view** (`conversation.overlay`): main's transcript and composer slide left, scale to 0.88 and dim, and keep streaming; its composer is covered by "Typing goes to the side chat · Back to main". The side chat comes forward as a sheet: a live `<Conversation/>` in a `ConversationScope`, under a cut marker ("forked from @ultimate at HH:MM · knows everything up to here"). The core transcript already hides a fork's inherited history. On a phone main recedes behind a bottom sheet with a "show main" strip; with `prefers-reduced-motion` both only fade. The id in front is the UI state `ext.side-chat.front`, so a reload restores the view; minimize parks the chat (it stays open in the sidebar and as a "Side chat · HH:MM show" chip above main's composer).
- **Ending:** Discard and Summarize & inject in the sheet's footer. Once `effects` is set, Discard is gone and one quiet line says why. A failed inject shows the model error and turns into Retry summary.
- **`sidechat.summary`** renders as a card in main, like an agent report, with a link to the side chat.
- **Sidebar:** open side chats are rows under @ultimate (the sidebar's `sidebar.under-ultimate` point); a row brings its chat to the front, or parks it when it is already there. Ended chats are not listed; side-chat names every side chat to the sidebar's `sidebar.unlisted` point, which keeps them out of its branch, Earlier and Concluded lists.

## Web contract

`refs.ts` exports:

- `SideChatDoc` (`sidechat`), on each fork: `{of, at, effects, ended?}`. An empty document is not a side chat. `of` is main; `at` is its last completed run's closing entry. `ended` is `discarded` or `injected`.
- `SideChatsDoc` (`sidechat.index`), on main: `{sides: [{id, at, openedAt, ended?}]}` in opening order. It retains ended chats for browsing. A single main-scoped document lets the sidebar subscribe once, without polling or scanning every conversation. Both documents use `fork: 'initial'`.
- `OpenAction`, `{text}` on main → `{id}`. Only the standing @ultimate may open one; nested side chats are refused. Multiple copies are allowed. A main with no completed turn cannot yet be forked.
- `DiscardAction`, `{id}` → `{id}`. Refuses effects, ending and ended chats. Stops the copy, concludes it and writes nothing to main.
- `InjectAction`, `{id}` → `{id}`. Requires an available `summaryModel` setting (Settings → Summary model). Stops the copy, summarizes only entries after `at`, writes one passive `sidechat.summary` entry in main and concludes the copy. Repeating inject joins the same durable task. Model errors are reported, never replaced with a plain-text fallback. A failed model call before write admission clears the ending receipt, so the copy accepts input and Inject can be retried (or Discard used if it has no effects). After write admission, the ending receipt is kept and replay must finish conclusion.

All three actions are user-only (`userActions`); agents cannot call them. Inputs and tools in an ended/ending copy are refused server-side.

`SideChatSummary` describes `sidechat.summary` entry data: `{side, at, from, to, questions?, text}`. `side` and `from` are the copy, `to` is main, and `at` is the fork entry. Questions, if any, currently remain in the summary text. Model content begins `Side chat #N (forked at HH:MM) summary:` (UTC). First the durable task memoizes the model answer, then submits a standard `type: 'write'` with requestId `sidechat:summary:<side>`, preserving main's inbox/reset order without starting a run. Finally it sets `ended`, concludes and completes the task in one commit. A crash after write admission but before conclusion reuses the model answer and the deduplicated write, then finishes conclusion. A busy main may not place the summary until its next boundary.

## Safety and attribution

`effects` is sticky and committed **before** a potentially effectful tool executes. It deliberately locks Discard even if that call subsequently fails: a crash must not leave an effect behind while Discard is still permitted. Tracked: branch, message, note, notify, remember, setup, restart, edit, write; todo add/done; automation except list/runs/log. Bash and codemode themselves are not tracked (their nested tracked tools still are).

Message, branch, note, notify and automation create/subscribe act as main via `lib/acting-as.ts`, which reads the sidechat document by kind and adds no dependency from core to this optional extension. Replies, branch reports, notification tasks and default automation subscribers therefore belong to main. A message to user retains the copy's identity and is refused: only @ultimate and branches message the user. A message to @ultimate is refused as messaging yourself. Branch starts, reply-requesting messages, notifications and automation create/subscribe also leave one deduplicated, non-waking provenance note in main.

## Fork boundary and prompt cache

The boundary comes from Pi's settled input `SubmissionRecord` (`type: 'input'`, `status: 'done'`, `answer`), not the newest assistant or a lagging summary. A completed `GenerationTask` is not enough: Pi completes one after each tool round and hands the still-active run to another generation. For a tool-terminated answer (notably message to user), we also include its matching tool-result entries, so the copy never inherits an unanswered tool call. The latest settled answer is selected before the forking transaction.

The agent and **all** its tools, including compact, remain inherited. Removing compact changes codemode's deferred-tool declarations in the system prompt, breaking cache-prefix equality. Identity and temporary-copy instructions are hidden per-input entries instead, using the existing `conversations.identity` renderer (no web facet is added). Standing agents are created ownerless without a lineage parent; forking @ultimate therefore reaches no tally root. No lineage branch event or branch document is written: side chats are neither roots nor branches in lineage and publish no abstracts to the project tally.

Opening sets metadata `label: 'side-chat'`, not the inherited `agent`; `ConversationSummary.branchOf` stays the raw fork origin `{conversationId: main, at}`, which lineage's `branchOf` service does not treat as a tally root.
