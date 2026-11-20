# Messages

Durable messages between conversations, standing agents and the user. Built in and on by default.

## Messaging

`message { to, text, reply?: true, steer?, images?, questions? }` returns the message id at once. Address a
conversation as `#123` or `123`, a standing agent as `@name`, or `user`.

- **Who may message whom.** Any conversation except a subagent may message `user`; a message to the user ends the run
  like a final answer. A subagent may message only its parent, so its work reaches the user through its coordinator.
  Automation runs and other top-level conversations may message any agent. Self-messages, unknown conversations and tallies (use `note`) are refused, as is the lander, which takes no
  messages; an unknown standing name lists the valid ones.
- **Delivery.** An idle recipient wakes. A busy one gets a follow-up after its current run, or steering with
  `steer: true`, the default for @ultimate's messages and `false` for everyone else. A message to a concluded
  conversation resumes it.
- **Answers.** With `reply` (the default) the recipient's final answer returns as a `board.reply`, steering the sender;
  one answer to several of the sender's messages returns once and closes them all. An unanswered input returns a
  `failed` reply, or `stopped` when a person pressed Stop. Answer directly instead of messaging the sender: a
  reply-enabled message back to a sender whose message you have read and owe becomes that answer and ends your run. A message still queued is unread and never owed. `reply: false` is one-way: it wakes the
  recipient and returns nothing.
- **Images.** `images` forwards images from the sender's own conversation: `'latest'` takes the newest entry with
  images in the current turn (its input, or a tool result such as a screenshot since) and fails when there is none; an
  entry id names an older one. At most `maxImages`, each at most
  `maxImageBytes`. `branch` takes `images` for its first message too.

### Waking upward: notes and reports

**A one-way message to the conversation that started you is a note, and stopping with nothing under way is your
report.**

- **Notes.** A one-way message from a subagent to its parent, or from a branch to its starter (`board.started`), is
  written with `delivery: 'note'`: it starts no run; the recipient reads it with its next request.
- **Reports.** After each run of a branch, its final answer goes to its starter, unless it already returned as a reply.
  When nothing of the branch is under way (no run, queued input, busy subagent, pending submission or open
  reply-enabled message), it goes as a one-way message with `report: true`, which wakes the starter; otherwise as a
  note, since the branch will run again. A landing concludes the branch and wakes the starter itself, asking through
  the `workspaces.branches` point this extension provides (`starter`, `underway`).
- **Answers back down.** The primary agent's final answer goes to each branch whose reply or report was an input of
  that run (not concluded, not messaged in the run) with `routed: true`, so a weigh-in reaches the branch. The run's
  other inputs (the user's, another Ultimate's, a card) neither receive it nor keep it from a branch.
- **Results to the asker.** A branch, waking automation or reply-expected `tell` started by @ultimate can own a request.
  New work takes it over if the run owes the request, reads its current owner's output or hears from its asker (their
  newest open request). Only the current owner's result goes back. A branch's result is final once it is concluded;
  local askers receive a normal early answer and then a one-way result.
- **Everything else wakes:** reply-enabled messages and one-way messages from anyone who is not the recipient's child or
  branch.

Routing cannot loop: an answer to a routed answer is an `echo`, placed as a note that wakes no one and routes no
further. Conversation waits are derived from existing records: work, an open user question, an open agent or remote
request, a subscribed timer, then an unconcluded branch's starter. Rows name the wait (`waits on @ultimate`,
`waits on #N`, `waits on ultimate-eval`, or `waits on <timer> · <time>`); a branch waiting on @ultimate also shows
its remote dependency, one hop only. Remote waits poll the target's optional Status progress every 15 seconds and
append ` · run 2/4` (using its label and counts), or ` · not running` when it cannot be reached. The Open messages
popover counts branches the conversation started that currently wait on it, rather than inferring a debt from past
reports. The browser reads `board.started` read-only.

### Messages to the user

A message to `user` shows in the sender's transcript and starts no run. For @ultimate it is its answer: the run ends
without restating it, unless a reply-enabled message it has read is still open or a branch whose reply or report the
run read still waits for its answer: the run goes on to its final answer, which routing sends there. While a user's message it has read is
open, @ultimate's message to the user answers it and, with `questions`, stays open itself, so it can ask one card after
another.

A reply-expected message to the user stays open, and its sender shows as awaiting reply, until the user answers that
message: a Reply with `re` (the answer card or a typed Reply). The delivered input reads `Answer to message N:` before
the reply, so an asker with several cards open never guesses which one it answers; a spoken (voice) reply answers no
card while several are open. Dismissing it closes it with a one-way note to the sender. A branch's question also puts an attention pointer (`board.asked`) in @ultimate's conversation, and the user's
answer a `board.answered` note there; neither starts a run. A branch with an open question shows as `waits on you`.

`questions` (checked in `questions.ts`) render under the message as the questions extension's answer card; see
[Questions](../questions/README.md). While a sender has questions open, its next input is preceded by a `board.open`
line listing them; @ultimate's lists every open question to the user and names `settle`.

`/?conversation=<c>&message=<m>`, such as a notification's link, opens at that question while it is still open, as
`messages:open {conversation, message}` does; otherwise it opens the conversation.

## Ultimate and branches

Talk to `@ultimate` in its own conversation (the first sidebar row; on phones, the top-bar button). It is the standing
orchestrator, not a coding worker. Model-facing text names standing senders `#12 (@ultimate)`, user replies `user`.

`branch { prompt, title?, root?, isolated?: true, images? }` (deferred; offered to definitions that name it) starts a
lineage branch from the explicit root, else the caller's tree root, else the only root, and sends the prompt as a
reply-enabled first message; it returns the branch and message ids. `title` (one line, at most 60 characters) names it
until its summary does. The branch runs the `coordinator` definition (instructions, pinned model and thinking when its
provider has a login, else the default model) with the caller's tools, labelled `coordinator`, and its caller is
recorded in `board.started`.

A branch's decisions go to @ultimate first, which weighs in; the branch then asks the user with a reply-expected message
with `questions` in its own conversation. Reports that need no answer use `reply: false`.

## Other projects' Ultimates

One @ultimate can message another project's @ultimate, on this machine or over the tailnet; nothing else crosses, and the
message is never the user's.

- **Sender:** codemode `ultimate.tell({ project, text, reply? })` (@ultimate only) posts the target's `messages.remote`
  action, located as codemode's `{ project }` reads are (`lib/remote.ts`). A failed post throws a sentence naming the
  project and machine. Telling an Ultimate whose question to you is still open is refused: answer it instead.
- **Target:** `messages.remote { key, text, reply, from: { project, machine } }` delivers to its own primary agent only,
  which reads `Message from @ultimate@<project> on <machine> (another project's Ultimate, not the user)`. A repeated key
  delivers once. A request that expects a reply is refused when the target has no route back to the sender (its
  `remotes` or the cloud register), so the sender's `tell` fails at once instead of waiting for an answer that cannot
  arrive.
- **One hop back:** with `reply`, the answer posts to the sender's
  `messages.remoteReply { key, text, failed, stopped?, interim? }` as a reply that expects none.
- **The reply is the wait.** `board.serving` records one owner per request. An answer that hands a remote request on
  arrives as an interim note and doesn't wake the asker. The current owner's final result closes the request and
  wakes the asker. A reply-expected `tell` can own a branch's relay request; the remote result returns to that branch.
- **Failures are loud.** Lost owners fail the request once. An answer that cannot be posted wakes the answering
  @ultimate with the cause and the undelivered text. Two Ultimates never loop: a reply expects no answer.
- **Durable on the sender:** `tell` logs the message and creates the `messages.tell` effect task in one commit; the
  task posts and settles the message `delivered` or `failed`. A crash before it settles posts again with the same
  key, which the target delivers once.

`remote` and `remoteReply` are user-only actions, reached only by another instance's HTTP call. A remote sender shows
as `@ultimate@<project> on <machine>` with a globe mark and a violet accent.

## Document and typed inputs

`Messages` (kind `board`, version 1) is exported on `ROOT_CONVERSATION_ID` as `{ messages: Message[]; next: number }`;
the log keeps the newest 300 items, and transcripts retain delivered inputs. `Message` is in `api.ts`: `from` and `to`
are a conversation id, `'user'` or `'remote'`; `state` is `sent`, `delivered`, `answered`, `dismissed`, `failed` or
`stopped`; `re`, `entry`, `answer`, `error`, `via`, `remote`, `report`, `questions` and `call` are optional.

- `board.message` data: `{ id, from, text, reply, delivery: 'steer' | 'followUp' | 'note', images?, remote? }`.
- `board.reply` data: `{ id, re, from, text, failed, stopped?, images?, remote?, interim? }`; `stopped` also sets
  `failed`; an `interim` reply is placed as a note (`delivery: 'note'`).
- Each post emits `board.sent` `{ message, from, to, reply, steer }` (`MessageSent`), never the text; replies emit
  nothing.

## Actions and service

- `remoteProgress({ project }) → { reachable, progress? }`: polls the project's `status/status` action with a short
  timeout. Progress is `{ label, index, total }` when provided. Unreachable or current-project targets return
  `reachable: false`.
- `addresses({}) → { agents, conversations }`: resident names and descriptions, with an id once created, and up to 50
  recent top-level conversation summaries.
- `settle({ messageId, text, dismiss? }) → { id }`: from @ultimate's conversation or its side chat, settles the user's
  open question for them from what they said there. `text` is their answer (with `dismiss`, why it no longer matters);
  the reply records `via`, so the card reads "@ultimate answered for you". Refused for other callers and closed
  messages. With `dismiss`, it also closes @ultimate's own open `tell` to another project, `text` as the reason.

There is no user posting action: users type in a conversation or answer a card. `host.want(MessagesApi)` (`api.ts`)
exposes `send`, a one-way message from a conversation, and `answer`, the user's reply to an open message.

## Files

Server side, imported in one direction (`log`, `images`, `addresses`, `questions` → `delivery` → `send` → `route` →
`branch`; `remote` → `delivery`):

- `server.ts`: wiring: the `message` tool, prompt section, hooks, actions, `MessagesApi` and the `workspaces.branches`
  point.
- `send.ts`: `send()`, validation, receipts, and turning a message to a sender you owe into that answer.
- `delivery.ts`: the `board.delivery` task, owner-output admission and the `board.settle` task that waits for that input.
- `route.ts`: the `board.route` task: notes, reports and answers back down.
- `outcomes.ts`: fail requests whose owner has stopped, failed or been deleted.
- `remote.ts`: `tell`, the `remote` and `remoteReply` actions.
- `branch.ts`: the `branch` tool.
- `addresses.ts`: resolving `to`, sender names, a subagent's parent and the lander.
- `images.ts`, `questions.ts`, `log.ts`: forwarded images, questions and the `board.open` line, the bounded log.

`api.ts` and `refs.ts` are the contract; `caller.ts` is shared with the browser; the `.tsx` files are the UI.

## UI

There is no Messages surface: everything renders in transcripts. Every sender has a stable accent (`accent.tsx`).

- **Cards:** typed messages and replies render as compact cards with Source / Return navigation, showing reply or
  one-way and the delivery mode. A `message` call renders as an outgoing card with its live state; a `branch` call as a
  branch-start card. Final answers name where they went, or "not sent".
- **Compact mode** (@ultimate's conversation): tool calls and thinking fold into “worked · N steps” rows, while
  messages, branch starts, workspace outcomes, setup cards and answers stay. Its messages to you are bubbles in its
  accent with the answer card beneath; one sent from codemode is a bubble too, under a quiet “sent with codemode” line.
  An answer routed back to branches folds to “replied to #id”.
