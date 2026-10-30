# Dreaming

Like people, agents need time to process what they learned. A dream is a working session: Ultimate reads back over
the project's conversations, memory, failures and tools, writes a journal of what it learned, and proposes changes:
to itself, and to how it works in this particular project (what it keeps doing by hand here, and what to build for it).
The user decides each proposal with @ultimate; approved ones become ordinary branches. When the work is done,
@ultimate prepares a fresh chapter and the user falls asleep into it. Nothing changes code, memory or storage by
itself.

A dream is ordinary work: one branch, its answer, the user's decisions, ordinary branches for what they approve. There
is no session to track. Dream's actions, called with codemode `ultimate.action('dream', name, args)`: `prepare
{chapter, learned, handoff}` and `stats` (tool numbers from the trace, no model). The trace keeps only about the last
7 days, so `stats` and `ultimate.trace` see only that window, and `stats` counts only tool calls; older failures and
model errors are found in conversation entries.

## For @ultimate

### Start

A dream starts when it is asked for, all the same way:

- the user tells you to dream ("start dreaming", "let's dream", "time for a dream");
- the user pressed Dream (a `dream.requested` input);
- a built-in automation fired: "Dream before compaction" when your context passed its threshold (70% by default), or
  "Dream after a pause" at 50% after the user was away 8 hours (its fire wakes you, and a `dream.requested` entry
  beside it carries the ask).

If a dream branch is already running, say so in one line and do nothing else. Otherwise, in that same turn, while your
context still holds everything, write your **handoff**: what you worked on, what is still open (branches, questions,
to-dos) and how far each got, the decisions and why, the user's corrections, the lessons, and what you would do next.
Start one branch with `branch`, the handoff in its prompt:

> Dream. Follow "For the dream branch" in the clone's extensions/dream/DREAM.md.
>
> My handoff:
> …

Name the memory slugs the user cares about most in it, always including the memory about the user (`about-<name>`).
Then end your turn with one line to the user. Other work may keep running: the dream only reads.

### Decide

The dream branch answers with its journal and its proposals as a `Decisions:` block. Relay them to the user as one
message with structured `questions`, the three learned lines first; at night they wait for the morning. Keep the card
to about 8 questions: give the proposals that need a decision of their own a `choice` each, and group the rest (the
small, low-risk ones: memory ops, doc lines) into one `multi` whose options are the proposals to approve, with the
ones you would approve marked `recommended`; two or more small proposals go into one `multi`, a lone one gets a
`confirm`. A multi answer comes back as its labels joined with ", ", so keep ", " out of those labels. Only during a hands-off goal do you decide them in the user's place: decide each as the user
would (keep what is evidenced and small; skip what is risky or vague), with one line on why. For each approved one:

- **Code, prompt or doc change:** start a branch for it, ordinary work (assess or build, review, land). A `project`
  proposal is built into the project's `.ultimate/`: put its evidence and the existing extension or feature pull
  request it adapts into the branch prompt, and the branch follows the integrate-ultimate skill.
- **Memory change:** apply it with one `remember` batch.

A codified memory (`retire` on the proposal) stays until its branch lands; then delete or update it with `remember`.

### Prepare the fresh chapter

A fresh chapter starts lean: the new @ultimate wakes from your handover, the memory and the open work instead of
re-reading a full context. Offer it when it is worth it: the dream's work has landed or been dropped (the branches
you care about are done), and either your context is well filled, the user was away for long, or the dream changed a
lot. After a small dream with plenty of room left, stay in this chapter and carry on.

When ready, call `prepare` once:

- `chapter`: a 2–3 word lowercase, dash-separated name drawn from what the dream learned (at most 40 characters);
- `learned`: exactly three short lines in your own voice ("I learned…", "I keep…", "I'd like…");
- `handoff`: a fresh handover, written now: what is open and how far each got, what landed from the dream, the
  decisions and the user's corrections, and what to do next (Markdown, at most 12,000 characters).

It puts the Fall asleep card in your conversation and pins it in the status line. Then send the user one message: what
the chapter carries, and that the card's Fall asleep button switches when they are ready. Only they press it; never
call `asleep`. Fall asleep refuses while any top-level conversation is busy and names them; a branch still running is
finished or stopped first, and one waiting on an answer should be named in the handover. `prepare` again replaces the
card.

## For the dream branch

You coordinate the dream. You change nothing: no code, no memory, no settings. You read, analyse and propose.

0. Read @ultimate's handoff first: it is in your prompt. It is @ultimate's own judgement while its context was full:
   what mattered, which threads are really open, which corrections counted. Put it in every pass brief as the primary
   input; the transcripts are the evidence behind it, and a pass checks the handoff against them rather than taking
   it on trust.
1. Run the six passes in parallel, each as a `dream-pass` subagent (background), with its pass name, the handoff and
   the brief below.
2. Check each report against its evidence; drop what does not hold up.
3. Answer @ultimate with the journal and the proposals:
   - three `learned` lines in Ultimate's own voice ("I learned…", "I keep…", "I'd like…");
   - the journal: one short section per pass, with its evidence;
   - each proposed change once: an id (a slug), its pass, a one-line title saying what changes, size (S/M/L), risk,
     and for codify proposals the memory slug it retires. A project proposal's title asks the question with its count
     ("Agents checked the device API by hand in 6 branches: build a `devices` tool here?");
   - a proposed name for the next chapter;
   - the proposals as one `Decisions:` block, one numbered item per proposal (`(a) do it; (b) skip.`), each naming its
     id, then `My picks:`.

### The passes

Every pass starts from @ultimate's handoff in its brief, then reads with codemode (`ultimate.entries`,
`ultimate.search`, `ultimate.conversations`, `ultimate.trace`), `memory`, `git log` and the code. Every claim cites
`#conversation/entry`, a trace error, a commit or `path:line`. Conversation summaries and abstracts (in the root's
tally, `ultimate.entries(<root>)`) are the cheap way in; open a conversation only where they point at something.

- **memory** — distil the project memory: memories that are outdated, contradicted, duplicated or too vague; lessons
  that later conversations taught but nobody remembered. Output add/update/delete ops, each with reason and evidence
  (the memory review in extensions/lineage/README.md). Never drop or weaken the memory about the user.
- **failures** — what failed often: `watchdog.failure` cards, tool and action errors in the trace, retries, reactor
  failures, lander rejections, runs the user had to stop. Group by cause; for the top ones propose a fix.
- **tools** — `stats` gives calls, failures, mean duration and enabled tools never called. Explain the numbers: why a
  tool fails, which are slow, which unused ones should be taught or removed, what agents did by hand that a tool
  should do.
- **corrections** — what the user had to say more than once, corrections of the agents' work, and the wishes: what
  Ultimate itself would like to have or be able to do, from friction seen in old conversations.
- **codify** — memories that should stop depending on being remembered and become how the harness works. For each
  candidate propose one of: code (a behaviour or default), a lint rule or check (only enforcement the user asked for;
  `no-guards` keeps most rules in prompts), agent definitions or docs (an instruction rather than a project fact), a
  skill (a multi-step procedure agents repeat across conversations but need only sometimes: clone `skills/`, the
  project's `.ultimate/skills/` or the user's `~/.ultimate/skills/`), or stays a memory (context about the project or
  the user). Say the memory delete or update that follows once it is codified. Also check the skills that exist: one
  that is stale, duplicated or never read gets an update or removal proposal.
- **project** — what Ultimate could do better in this project's own work. Read the root's tally (abstracts and
  landings), the project's conversations and `git log`, and look for what repeats: steps agents did by hand again and
  again (the same commands, checks, lookups, setup), what the user asked for more than once, and where branches got
  stuck on something specific to the project (dev server, test data, environment, deploy). Each proposal says what
  happened and how often, with `#conversation/entry` or commit evidence, and what to build in `<project>/.ultimate/`:
  an extension, a surface, an agent, a skill or a setting, following the integrate-ultimate skill. Before proposing
  something new, look for one to adapt in the clone's `extensions/` and the open feature pull requests
  (`gh pr list --repo HazAT/ultimate --label feature`). It proposes; it builds nothing. When the project is Ultimate
  itself, leave Ultimate's tools and harness to the tools and codify passes and look only at the project's own work;
  say "nothing project-specific" when that is what you found.
