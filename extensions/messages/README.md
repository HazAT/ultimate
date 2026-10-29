# Messages

Durable messages between conversations, standing agents and the user. Built in and on by default.

## Messaging

`message { to, text, reply?: true, steer?, images? }` returns the message id immediately. `images` forwards
images from the sender's own conversation, since a model cannot produce image bytes: `'latest'` takes the newest
entry with images (a pasted input or a tool result such as a screenshot, searching the whole history), a number names
that entry. The reference resolves when the message is admitted (at most
`maxImages`, each at most `maxImageBytes`; unknown entries or entries without images are refused); the log records
`images: { entry, count }`, and delivery attaches that entry's images to the recipient's input, so a replay attaches
the same ones. `branch` takes the same `images` for its first message. @ultimate's messages to the user carry them
too: its bubble shows that entry's images as thumbnails that open full size.
Address a conversation
as `#123` or `123`, or a standing agent as `@name`. The lander runs no model and takes no messages.
Only the `ultimate` resident's standing conversation may message `user`; other senders must send @ultimate a one-way update to relay.
Self-messages, unknown conversations and tallies are refused; use `note` for a tally. Unknown standing names list
the valid ones. Standing agents are resolved and configured through the `subagents` service at delivery admission.
Each post emits `board.sent` `{ message, from, to, reply, steer }` (`MessageSent`) in the posting commit, never the
text; replies are no posts and emit nothing.

An idle recipient wakes. A busy one receives a follow-up after its current run, or steering during that run with
`steer: true`. `steer` defaults to `true` for @ultimate's messages, to any recipient including standing agents, and
to `false` for everyone else; an explicit value always wins. The typed `board.message` input identifies its sender and explains where its answer goes. Its `delivery`
field records `steer` or `followUp`.
The answer returns as `board.reply`, steering the sender. An unanswered input produces a failure reply instead.
Answer directly rather than messaging the sender. A reply-enabled agent message back to a sender whose
reply-enabled message the agent has received and not answered becomes that answer: in one commit `send()` marks the
original `answered`, appends the reply (`re`, `reply: false`, its `images`, its `call`) and starts the delivery task
in its reply phase; its `steer` and `reply` flags are ignored. The original's delivery then sees it answered and keeps
the final answer local, and the tool returns `Sent as your answer to message N.` with `terminate`, so the run ends
without restating it. A replayed call finds the reply through the `board.sent` receipt and memo, so it is sent once.
`reply: false` updates and other recipients are unaffected. @ultimate's message to `user` is never refused for an
owed answer: while a user's message it has read is open, the message answers it (marked `answered`, the new one
names it in `re`, its delivery keeps the final answer local) and, with `questions`, stays open itself, so a
conversation such as the onboarding walkthrough can ask one card after another. A message still queued is unread
and is never treated as owed: a message to its sender then goes as a new message, and the queued one gets its own
turn and its own answer.
A subagent (a conversation its parent lists in `ultimate.subagents`) may message only that parent, so its work reaches
the user through its coordinator and @ultimate; its prompt says so. Automation runs and top-level conversations may
message any agent; only @ultimate may message the user.
`reply: false` is one-way: it wakes the recipient without returning an answer, and its model text says the
answer is not sent. The log records its answering assistant entry in `answer` while keeping state `delivered`;
no reply is appended.

### Waking upward: notes and reports

One rule decides whether talking upward wakes anyone, from state rather than text: **a one-way message to the
conversation that started you is a note, and stopping with nothing under way is your report.**

- **Notes.** A one-way message from a subagent to its parent, or from a branch to its starter (the conversation that
  called `branch`, kept in the branch's `board.started`), is a `board.message` write with `delivery: 'note'` and no
  `input` flag. It starts no run; the recipient reads it with its next model request. The note's delivery decision is
  saved in the task input for replay.
- **Reports.** After each run of a branch, a background `board.route` task (one per generation, from an `onYield`
  hook) looks at its final answer. The answer to the starter's reply-enabled message already returns as that
  message's reply, so it is skipped, as are empty, failed and aborted answers. So is a run whose every input was
  another conversation's reply-enabled message (a sibling branch's, a subagent's question): its answer goes back to
  them only. If that run left the branch with nothing under way and the starter's latest message from it was a note,
  that note's text goes again as the report, so the starter still wakes. Otherwise, if nothing of the branch is
  still under way (no run or queued input in it or a subagent at any depth, no subagent report or waking `notify`
  on its way, no submission in the lander's queue or a failure being reported, no reply-enabled message of its own
  still waiting), the answer goes to the starter as a one-way message with
  `report: true`, which wakes it as a follow-up. While something is still under way it goes as a note: the branch
  will run again when that work wakes it. A landing ends a branch's work without a run: the lander concludes it
  unless `underway` says otherwise and wakes the starter itself (`extensions/workspaces/README.md`), asking through
  the `workspaces.branches` extension point that this extension provides (`starter`, `underway`).
- **Everything else wakes.** Reply-enabled messages, and one-way messages from anyone who is not the recipient's
  child or branch (another branch, an automation's escalation, another project's Ultimate), are inputs.

Routing cannot loop: it goes only from a branch to its starter, which existed before it, and a routed message is
one-way, so the starter's answer to it goes nowhere. Request id `route:<answer entry>` deduplicates delivery in the
branch's `board.requests`, so a restart never sends an answer twice.

A branch whose latest report came after the starter's latest message to it shows as `awaiting @ultimate`
(`conversationState` in `data.tsx`), as does one with a reply-enabled message to @ultimate still open; @ultimate
messaging the branch, or concluding it, clears it.

Sending to `user` writes a message
shown in @ultimate's transcript; it starts no run. The message is @ultimate's answer: a direct `message` call to
`user` returns `terminate`, so the run ends without a final answer that would restate it, when every call of that
tool round does so. It does not while a reply-enabled message @ultimate has read is still open, so that reply is
still answered; codemode's nested calls never end the run.
A reply-enabled message to `user` stays open, and its sender shows as awaiting reply, until the user answers that
message: a user Reply with `re` (an answer card, or a typed Reply) marks only that message answered, in the reply's
commit. Plain input, new posts and answers to other questions leave it open. The service's `dismiss` closes it as
`dismissed` instead, with a one-way user note to the sender (`re`, delivered as a note: no run starts) in the same
commit. The asker itself closes a question the user no longer needs to answer (a newer one superseded it, the matter
settled elsewhere) with the `withdraw` action: the message becomes `withdrawn` with its `reason`, leaves the To-dos
panel and the open-questions note, and its bubble's footer reads `withdrawn · <reason>`. Only the conversation that
asked may withdraw it; the open-questions note names the action.

While the sender has questions open, the input that starts its next run goes in after a `board.open` entry, placed
by the patched `beforeInput` hook in the input's commit: one user-role line listing each open message's id, first
line and age. It renders nothing in the transcript. It is per input rather than a system-prompt section, so the
prompt stays cached; nothing is added while nothing is open.

A reply-expected agent message to `user` may carry `questions` (the `message` tool's argument, checked in
`questions.ts`; refused ones come back as the tool's error naming the question). The sender's outgoing `message` card
in its transcript shows them under the message body while it is open, as the questions extension's answer card. Its
user-only `answer` action posts a normal user reply with `re` and the answers in the message's numbering, waking the
sender. Its admission atomically checks that the original message is still open, preventing duplicate replies. See
[Questions](../questions/README.md).

In the sender's transcript a `message` call renders as an outgoing card: recipient, one-way or expects reply, and
the message's live state from the messages log (sending, delivered, awaiting reply, awaiting your reply, answered,
failed, stopped by the user), with an Open link to the recipient's entry. A `branch` call renders as a branch-start card: the branch's
feature and title, its root, isolated or shared, working or reported back, an Open link to its first input, and
the prompt. Failed calls of either tool keep the generic tool card with their error.

The message tool is replay-safe: it memoizes the sent id. A task-scoped `board.sent` receipt commits with the
message and delivery task, preventing a duplicate even if interrupted before the memo is saved.
Delivery is a background durable task owned by the root conversation. Stable request ids (`board:<id>` and
`board-reply:<reply-id>`) deduplicate submissions across reopen. Recording the answer, appending its reply and
advancing the task checkpoint happen in one transaction. A reopened task resumes that checkpoint, so both a
placed input awaiting an answer and a recorded answer awaiting delivery survive without duplicate replies.
One-way input deliveries also wait for the answer; recording it and completing the task commit together.
Note deliveries complete after placement, without waiting for an answer.
A delivery that triage, before its removal, had already written as context (`board:<id>` or `board-reply:<id>` is a
write) resumes with one short `board-wake:<id>` input after it, so the recipient still wakes once.
When the recipient's input hooks refuse placement, the message becomes `failed` with `error` naming the cause, and
the task completes instead of faulting with the message stuck in `sent`. A reply-enabled message whose recipient ends
its run without an answer gets a reply in its place: `stopped` when the run or its queued input was aborted (a person
pressed Stop; the reply reads `was stopped by the user before it answered` and the sender's input says `(stopped)`),
`failed` for anything else (a crash, a provider error, an empty answer). A message to a concluded conversation is
delivered like any other: its input resumes it, and its next request recreates a released checkout.

## Ultimate and branches

Talk to `@ultimate` in its own conversation to start and steer work, using the first sidebar row (on phones, the top-bar @ultimate button). It is the built-in standing orchestrator, not a coding worker.
Model-facing messages identify standing senders as `#12 (@ultimate)`; ordinary
conversations stay `#id`, and user replies say `user`. Before delivery, standing recipients are refreshed from their
current definitions, including numeric-address messages and automatic replies.

The deferred `branch { prompt, title?, root?, isolated?: true }` tool is offered only to definitions that name it.
`title` (one line, at most 60 characters) names the branch in the sidebar and the tally until its summary renames it.
It chooses the explicit root, otherwise the caller's tree root, otherwise the only root. Ambiguous or missing roots
produce an error listing the available ids. It forks the root's tally tip through lineage, attributes the tally's branch
line to the caller, and sends the first input as a message with replies enabled. It returns the branch id and message id.
The branch's answer therefore wakes its caller as a normal `board.reply`.
The tool records the caller in the branch's `board.started` document, so later answers reach it as notes or reports
(see Waking upward).
Before sending its first input, the tool rereads the `coordinator` definition (built-in, user, then trusted project override), applies its instructions and the model and thinking level it pins (thinking clamped to what the model supports), and marks `ultimate.metadata.label = 'coordinator'`. A pin whose provider has no login here is skipped; without a usable pin the branch starts on the default model (`defaultModel` in `lib/agents.ts`: Pi's default when it has a login, else the first model that has one), never on the root's stored model. Its tools stay inherited either way. Coordinators report results, decisions and landings to @ultimate in their final answers, which route as reports.
The tool gives lineage its task and call ids for a task-scoped receipt, recorded atomically with the fork, so replay cannot
create another branch even before the branch-id memo is saved. Pi retires that receipt when the originating task completes.
It deduplicates message admission with the same task-scoped `board.sent-calls` receipt as `message`, indexed by call id
so nested codemode calls stay distinct.

Ultimate answers the user's typed input directly in its conversation. To relay a branch result, decision or landing
to the user, Ultimate sends one consolidated `message {to: 'user', text}` when the needed replies have arrived.
It appears there as a bubble with an answer card for questions. Decisions use a reply-expected message with
`questions` (see [Questions](../questions/README.md)); reports that need no answer use `reply: false`.

## Other projects' Ultimates

One @ultimate can message another project's @ultimate, on this machine or over the tailnet, so it can drive that
instance end to end. Nothing else crosses: the sender cannot address any other conversation there, and the message is
never the user's.

- **Sender:** codemode `ultimate.tell({ project, text, reply? })` (@ultimate only) logs a message `to: 'remote'` with
  `remote: { project, machine, key }`, a fresh random key, then posts the target's `messages.remote` action, located as
  codemode's `{ project }` reads are (`lib/remote.ts`: loopback, the address set in the `remotes` user setting, else
  the tailnet address from the cloud register when backups are on; the
  target's own `Origin`, admitted by `tailscale.allow` on the tailnet). A failed post marks the message failed and the
  call throws a sentence naming the project and machine. Telling an Ultimate whose reply-expected message to you is
  still open is refused: answer it instead.
- **Target:** `messages.remote { key, text, reply, from: { project, machine } }` logs a message `from: 'remote'` to its
  own primary agent, the only recipient it can reach, and delivers it like any other: as a steer, with
  receipts. The model reads `Message from @ultimate@<project> on <machine> (another project's Ultimate, not the
  user)`. The `board.remote` document maps each key to its message in the same commit, so a repeated post (a retry,
  a replay) returns the first id and delivers nothing new.
- **One hop back:** with `reply`, the delivery's answer phase posts it to the sender's `messages.remoteReply { key, text,
  failed, stopped? }` instead of a local conversation. The sender records it as a reply `from: 'remote'` with `re` and
  `reply: false`, delivered by the usual reply phase, so its answer goes nowhere. The sender keeps each reply-enabled
  tell in `board.remote` until its answer arrives (the log drops old messages), so a late answer still lands;
  `remoteReply` refuses any other key, including a one-way tell's, and a second answer returns the first one's id.
  Two Ultimates therefore exchange at most a message and its answer per `tell`; continuing is a new `tell`.
- **Not durable on the sender:** `tell` runs inside codemode, which is not replayed. A crash between logging and
  posting leaves the message `sent`, never posted; telling again uses a new key.

`remote` and `remoteReply` are user-only actions: only another instance's HTTP call reaches them, never an agent's
`ultimate.action`. In compact mode a remote sender is named `@ultimate@<project> on <machine>` with a globe mark and a
violet accent no conversation uses.

## Document and typed inputs

`Messages` (kind `board`, version 1) is exported on `ROOT_CONVERSATION_ID`:

```ts
{ messages: Message[]; next: number }
```

`next` starts at 1. The log keeps the newest 300 items; transcripts retain delivered inputs.
Version 1 remains loadable: Pi documents do not validate object fields, so existing logs' unused `readUpTo` field needs no migration.

```ts
type Message = {
  id: number
  from: number | 'user' | 'remote'
  to: number | 'user' | 'remote'
  text: string
  at: number // Unix milliseconds
  reply: boolean
  re?: number
  state: 'sent' | 'delivered' | 'answered' | 'dismissed' | 'withdrawn' | 'failed' | 'stopped'
  entry?: EntryId
  answer?: EntryId
  error?: string
  reason?: string // why its sender withdrew it
  remote?: { project: string; machine: string; key: string; id?: number } // the other Ultimate
  report?: true // a branch's routed final answer after it stopped with nothing under way
  questions?: Question[] // what a reply-expected message to the user asks (see Questions)
}
```

`board.message` data: `{ id, from, text, reply, delivery: 'steer' | 'followUp' | 'note', images?, remote? }`, where `images` counts the forwarded images in its model content; the card shows them as thumbnails.
`board.reply` data: `{ id, re, from, text, failed, stopped?, images? }` (`stopped` also sets `failed`: neither is an answer); a reply that a `message` became carries its images like a message does. A reply has its own id and `re` points to the original message.
The reply's `answer` links to the recipient's assistant entry; the original also stores its input `entry`.

## Actions

- `addresses({}) → { agents, conversations }`: resident names/descriptions with an id if already created, and up to
  50 recent top-level conversation summaries (including title and label).
- `withdraw({ messageId, reason }) → { id }`: the calling conversation closes its own open question to the user
  unanswered as `withdrawn` with `reason` (kept on one line, whitespace collapsed, at most 200 characters). Refused for a message that is not an
  open question to the user, and for any conversation but its sender; the user dismisses instead.

Users type in @ultimate's conversation or answer a question card; there is no user posting action.
Agents use the `message` tool. The prompt section is stable and lists resident names and descriptions.

## Service

`host.want(MessagesApi)` exposes `send`, a one-way message from a conversation, and `answer`, the user's reply to an open message (the questions answer card). Landings and submissions
append no log items. `MessagesApi`, `Message` and the `Messages` document live in `api.ts`.

## Files

Server side, imported in one direction (`log`, `images`, `addresses`, `questions` → `delivery` →
`send` → `route` → `branch`; `remote` → `delivery`), each sharing only the `Messages` log and explicit helpers:

- `server.ts`: wiring: the extension definition, the `message` tool, the prompt section, hooks, actions and the
  `MessagesApi` service and the `workspaces.branches` extension point.
- `send.ts`: `send()`, its validation, receipts (`Sent`, `Requests`) and the conversion of a message to a sender you
  owe an answer into that answer.
- `delivery.ts`: the `board.delivery` task, its `deliver` and `reply` phases.
- `route.ts`: the `board.route` task, which returns a branch's final answers to its starter as notes or reports.
- `remote.ts`: `tell`, the `remote` and `remoteReply` actions and `RemoteDoc`.
- `branch.ts`: the `branch` tool.
- `addresses.ts`: resolving `to`, sender names, a subagent's parent and the lander.
- `images.ts`: resolving and attaching forwarded images.
- `questions.ts`: checking `questions`, open questions and the `board.open` note.
- `log.ts`: appending to the bounded log.

`api.ts` and `refs.ts` are the contract; `caller.ts` is shared with the browser; the `.tsx` files are the UI.

## UI

There is no Messages surface: the extension is plumbing, and everything it carries renders in transcripts. You talk to
@ultimate in its own conversation (the sidebar's top row, and on phones the title bar's `@ultimate` button, both in
[sidebar](../sidebar/README.md), open it). Every sender has a stable accent (`accent.tsx`: you the
brand colour, others a small palette by id) shown as a stripe, a faint fill and the sender name. Typed
messages and replies render as compact transcript cards with Source / Return navigation, in the sender's accent.
Incoming messages show whether they expect a reply or are one-way, plus their delivery mode (steered, follow-up or note) when recorded. Final answers name their reply
destination, or say “not sent” for a one-way message. Answers that cover several messages list each
destination; unrelated answers show no messaging label.

@ultimate's own conversation uses compact mode (the `compact` contribution): each run of tool calls and thinking folds into
one “worked · N steps” row, while messages, branch starts, workspace outcomes, onboarding setup cards and answers stay. Its messages to you
are bubbles on the left in its accent, their footer saying awaiting your reply, answered or one-way; an answer card
mounts beneath the text (`Bubble` children). Each log message records the tool call that sent it (`call`: the
`message` call's id, or `<script>/<n>` for a nested codemode call), so a message @ultimate sent from a `codemode`
script is a bubble too, bound to that exact message, beneath a quiet “sent with codemode” line that opens the script.
The script shows as soon as the log holds a message it sent, while it runs or after it was interrupted; messages from
before the log recorded calls, or that the bounded log dropped, leave it folded. Once the bounded log has dropped a
direct message, its bubble shows no state. An answer that went back to the branches that asked folds to “replied to
#id”.
