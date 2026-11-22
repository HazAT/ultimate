Side chats are temporary, ownerless copies of the standing @ultimate conversation, or of the conversation that asked an open question (see [Question side chats](#question-side-chats)). The user opens one to explore a tangent, then discards it or sends a summary back without waking main. A side chat keeps its fixed `Side chat` title: `open` turns its automatic summaries off (`setAutomaticSummaries` on the conversations service), so no intent, reply or spawn trigger asks the summary model; only Summarize & inject does.

## UI (`web.solid.tsx`)

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
- `InjectAction`, `{id, answer?}` → `{id}` (`answer`: see Question side chats). Requires an available `summaryModel` setting (Settings → Summary model). Stops the copy, summarizes only entries after `at`, writes one passive `sidechat.summary` entry in main and concludes the copy. Repeating inject joins the same durable task. Model errors are reported, never replaced with a plain-text fallback. A failed model call before write admission clears the ending receipt, so the copy accepts input and Inject can be retried (or Discard used if it has no effects). After write admission, the ending receipt is kept and replay must finish conclusion.

All three actions are user-only (`userActions`); agents cannot call them. Inputs and tools in an ended/ending copy are refused server-side.

`SideChatSummary` describes `sidechat.summary` entry data: `{side, at, from, to, questions?, text}`. `side` and `from` are the copy, `to` is main, and `at` is the fork entry. Questions, if any, currently remain in the summary text. Model content begins `Side chat #N (forked at HH:MM) summary:` (UTC). First the durable task memoizes the model answer, then submits a standard `type: 'write'` with requestId `sidechat:summary:<side>`, preserving main's inbox/reset order without starting a run. Finally it sets `ended`, concludes and completes the task in one commit. A crash after write admission but before conclusion reuses the model answer and the deduplicated write, then finishes conclusion. A busy main may not place the summary until its next boundary.

## Question side chats

- **Open:** a question card's **Talk it through** calls `open {message}`. It forks the asker (a branch or @ultimate) at the tool results of the round that asked: a nested codemode call forks at its script's result.
  - It checks first that the message still waits on the user, then returns the side chat already open for it, if there is one, so there is one per card.
  - While that tool round has not finished, it refuses and asks to try again.
- **Where it shows:**
  - On the agent surface the sheet opens over the asker's transcript; `Stage` and the composer chips work over any conversation with open side chats, not only @ultimate. The transcript layer behind it is `inert`, so its card takes no clicks or keys.
  - In the Inbox the reading pane becomes the side chat in front (inbox's `QuestionPane` point). It stays there after the question is answered elsewhere, until the user parks or ends it.
  - The card's button always reads **Talk it through**; once a side chat is open it brings that one back.
- **Card pinned on top:** the question's card is pinned and foldable. The cards share their drafts (questions' durable card state), so picks made on either side show on both.
  - Its Send reads **Summarize & send**: `inject {id, answer}`. One commit checks that the question is still open and creates the ending task. The task writes the summary, rechecks the question, then answers it with a receipt, so a crash or a reload sends the answer once. A failed summary sends nothing; a closed question is refused before anything is written.
  - **Summarize only** sends the summary without answering.
  - Discard always works, since nothing can have effects.
- **Read-only:** `beforeTool` blocks every tool except read, bash, memory, web search and fetch, and `draft_answers`.
  - Browser and screenshot are blocked: they load pages that can act. Codemode is blocked too, because its `ultimate.action` and `ultimate.tell` write without a tool call.
  - `draft_answers {answers?, note?, text?}` (deferred; the fork enables and loads it) fills in the card's durable draft (`ext.questions.cards` in the UI state) when the user says what to pick. It resolves answers with the card's own rules (`lib/question-cards.ts`), refuses what the card cannot show, and keeps a per-call receipt so a replay writes nothing. It never sends: the user reviews the draft on the pinned card and sends it.
  - Elsewhere it is reachable only through `tool_search`, and it refuses outside a question side chat.
  - Known limit: the UI state stores the cards as one value. If the user edits the card in the 150 ms before their browser saves it, that save can overwrite a fill that landed in between; the side chat's answer still says what it filled in.
- **Ending with an answer:** `inject {id, answer}` while a summary without an answer is under way, or the other way round, is refused rather than joined. If the question is answered elsewhere between the recheck and the send, the task still concludes: the summary stands and no second answer goes out. The task records the device the answer came from.
  - `actingAs` maps such a side chat to itself, not to the asker, so it borrows no identity.
  - Bash is only reminded, not sandboxed.
- **Reminder and summary:** the hidden reminder says the chat is read-only and that the user answers on the card. The summary prompt asks for what the user leaned towards and why, and never invents an answer. The asker reads the summary just before the answer.
- **Documents:**
  - `SideChatDoc` gains `question` and `tokens`: the asker's context at the fork, shown in the sheet header as the cost of the first turn.
  - `SideChatsDoc` sits on the asker.
  - `QuestionSidesDoc` (`sidechat.questions`, on conversation 1) lists every question side chat, so a card or the Inbox finds its own with one subscription.
- **Lineage:** lineage skips its catch-up note for any side chat, so a quick question is not preceded by the commits that landed since. Side chats stay out of the sidebar's lists through `Unlisted`.

## Safety and attribution

`effects` is sticky and committed **before** a potentially effectful tool executes. It deliberately locks Discard even if that call subsequently fails: a crash must not leave an effect behind while Discard is still permitted. Tracked: branch, message, note, notify, setup, restart, edit, write; todo add/done; automation except list/runs/log. Bash and codemode themselves are not tracked (their nested tracked tools still are).

Message, branch, note, notify and automation create/subscribe act as main via `lib/acting-as.ts`, which reads the sidechat document by kind and adds no dependency from core to this optional extension. Replies, branch reports, notification tasks and default automation subscribers therefore belong to main. A message to user keeps the copy's own identity, so it never speaks as @ultimate. A message to @ultimate is refused as messaging yourself. Branch starts, reply-requesting messages, notifications and automation create/subscribe also leave one deduplicated, non-waking provenance note in main.

## Fork boundary and prompt cache

The boundary comes from Pi's settled input `SubmissionRecord` (`type: 'input'`, `status: 'done'`, `answer`), not the newest assistant or a lagging summary. A completed `GenerationTask` is not enough: Pi completes one after each tool round and hands the still-active run to another generation. For a tool-terminated answer (notably message to user), we also include its matching tool-result entries, so the copy never inherits an unanswered tool call. The latest settled answer is selected before the forking transaction.

The agent and **all** its tools, including compact, remain inherited. Removing compact changes codemode's deferred-tool declarations in the system prompt, breaking cache-prefix equality. Identity and temporary-copy instructions are hidden per-input entries instead, using the existing `conversations.identity` renderer (no web facet is added). Standing agents are created ownerless without a lineage parent; forking @ultimate therefore reaches no tally root. No lineage branch event or branch document is written: side chats are neither roots nor branches in lineage and publish no abstracts to the project tally.

Opening sets metadata `label: 'side-chat'`, not the inherited `agent`; `ConversationSummary.branchOf` stays the raw fork origin `{conversationId: main, at}`, which lineage's `branchOf` service does not treat as a tally root.
