Hands-off goals: put @ultimate on a goal and go away; it decides what it would otherwise ask you, records each decision with its reason, and leaves a report.

## Flow

1. The user opens ⌘K **Go hands-off…** and writes the goal in their own words (what to reach, and when to stop if
   they want), or presses **Start this goal** on a goal @ultimate proposed with `goal {action: 'propose', text}`, after
   editing it if they like. User-only `start` records goal N in the `goal` document on conversation 1 and submits a `goal.started`
   input to @ultimate (request id `goal.started:N`, a follow-up when busy). Only one goal is open at a time.
2. While the goal is open, every run of @ultimate starts with a `goal.note`: the goal, its criteria with their state,
   and the rule: decide instead of asking, record each decision, keep going. The note is per input, never a
   system-prompt section, so the prompt cache holds. Nothing else switches: the prompts of @ultimate and the
   coordinators point to the note.
3. @ultimate keeps the goal with its deferred `goal` tool (any other caller is refused):
   - `criteria {criteria}` writes what done means, each checkable;
   - `decide {question, picked, reason, conversation?, images?}` records a decision it took for the user, such as a
     branch's go or a UI preview it approved; `images` (`"latest"` or an entry id of its conversation) keeps the
     screenshots it judged;
   - `met {n}` and `failed {n}`: a criterion is blocked after 3 failed tries; work goes on with the others;
   - `finish {outcome: 'met' | 'blocked', summary}` ends the goal;
   - `pause {reason}` when it is truly blocked on the user: the reminder pauses and the card shows "Waiting on you:
     <reason>"; `resume` turns it back on once it can go on. An answer from the user does not resume it by itself:
     an answer may not unblock the goal, so @ultimate resumes when it does, and the goal note reminds it while paused.
4. **Goal reminder.** While a goal is open, a "Goal reminder · goal N" automation wakes @ultimate: `every 30m`, no
   prompt, @ultimate as its subscriber; its id is the goal's `reminder`. Every goal change (start, pause, resume,
   end) creates a `goal.reminder` task in its own commit, which brings the automation in line with the goal through
   the automations service (`AutomationsApi`): create and link, pause, resume or delete. A crash leaves the
   task to rerun; a rerun adopts the automation an earlier try made by its name, and one the user deleted in the
   Automations panel stays deleted. On a fire, the goal note adds what to check: the goal's branches moving, the lander queue, reactor lag
   and watchdog cards; nudge or fix what is stuck, record a `decide` only when it changed something, else stay quiet. This replaces the manual night watch while a goal is open.
5. The goal ends when @ultimate finishes it or the user presses **End hands-off** on its card (user-only `end`). Either
   way a `goal.report` card is written into @ultimate's conversation (`goal.report:N`), and from then on it asks the
   user as usual.

There is no budget or rule list: what stays the user's (secrets, logins, force pushes) is already theirs elsewhere,
and the rest is @ultimate's judgement. Pause in the status line stops everything at once, as always.

## UI

- `goal.started`: the goal in the user's words, its criteria (open, met, blocked with failed tries), the latest three
  decisions, the reminder's state (waking every 30 minutes, or "Waiting on you: <reason>" while paused) and **End
  hands-off**; once ended, it points to the report.
- `goal.report`: the outcome (met, stuck, ended by you), the summary, the criteria and every decision with its time,
  its conversation, what it would have asked, what it picked and why, and any screenshots it judged.
- `goal {action: 'propose'}`: the proposed goal in an editable field and **Start this goal**, disabled with "Goal N is
  still open" while one is; once started from it, the goal's text and "you started it as goal N". The goal keeps the
  call id as `proposal`.
- A quiet **Hands-off** mark in the status line while a goal is open; it opens a popover with the goal, its criteria, the decision count and the last two decisions, with links to @ultimate and End hands-off.

## Actions

- `start { text, proposal? }` → the new goal; `proposal` is the id of the proposal's tool call. User-only.
- `end` → the ended goal. User-only.
- `images { goal, entry }` → the images of a decision's screenshot entry, for the report card.
