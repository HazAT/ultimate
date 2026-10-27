# Dreaming

Like people, agents need time to process what they learned. A dream is a working session: Ultimate reads back over
the project's conversations, memory, failures and tools, writes a journal of what it learned, and proposes changes:
to itself, and to how it works in this particular project (what it keeps doing by hand here, and what to build for it).
The user decides each proposal with @ultimate; approved ones become ordinary branches, and the dream follows them
until they land. Nothing changes code, memory or storage by itself.

Session N lives in the `dream.sessions` document (`refs.ts`) on conversation 1: read it with codemode
`ultimate.doc('dream.sessions', 1)`. Actions, called with codemode
`ultimate.action('dream', name, args)`: `handoff {text}`, `pass {session, pass, status, note?}`, `journal {session, learned, text,
proposals, chapter?}`, `decide {session, proposal, status, branch?}` and `stats` (tool numbers from the trace, no model). The trace keeps only about the last 7 days, so
`stats` and `ultimate.trace` see only that window, and `stats` counts only tool calls; older failures and model
errors are found in conversation entries.

## For @ultimate

A dream starts with your **handoff**. The user pressed Dream (a `dream.handoff` input asks for it), or the built-in
"Dream before compaction" automation fired because your context passed its threshold (70% by default), or "Dream after
a pause" fired at 50% after the user was away 8 hours (a `dream.handoff`
entry beside the fire carries the same ask, and the fire's turn is the one to write it in).
Write it in that same turn, while your context
still holds everything: what you worked on, what is still open (branches, questions, to-dos) and how far each got,
the decisions and why, the user's corrections, the lessons, and what you would do next. Plain Markdown, at most
12,000 characters; record it with one call, `ultimate.action('dream', 'handoff', {text})`, then end your turn with one
line to the user. A second call replaces the first while the dream still waits. The dream starts by itself once the
handoff is recorded and no other conversation is running a model response or tool call; after 30 minutes without one
it starts without it and says so.
The dream reads the handoff first, and a new chapter wakes up from it.

A `dream.started` input means the session began after your handoff. Start one
branch with `branch`, prompt:

> Dream session N. Follow "For the dream branch" in the clone's extensions/dream/DREAM.md.

Name the memory slugs the user cares about most in it, always including the memory about the user (`about-<name>`).
The branch answers you with the journal's proposals as a `Decisions:` block; its card is already in your conversation.
Relay the decisions to the user as one message with structured `questions`; at night they wait for the morning. Only
during a hands-off goal do you decide them in the user's place: decide each proposal as the user would (keep what is
evidenced and small; skip what is risky or vague), and record it with `decide {…, reason}`, one line on why. For each
decision:

- **Approved code, prompt or doc change:** start a branch for it (it is ordinary work: assess or build, review, land),
  then `decide {status: 'approved', branch}`. The dream marks it landed when that branch lands. When it reaches the
  repository another way (merged or fast-forwarded by hand), record `decide {status: 'landed', sha, repo}` with the
  commit and the repository it is in (the clone path for Ultimate work; default the project folder); the dream
  refuses a sha not reachable from that repository's HEAD.
- **Approved work whose result is not in a repository** (files under a non-git folder such as `~/sk/.ultimate`):
  once written, `decide {status: 'applied', reason}` with the reason naming what was written, e.g. "files in
  ~/sk/.ultimate/skills/sk-verify". `applied` means the change is in place outside git; the dream refuses it without
  a reason. A `project` proposal
  is built into the project's `.ultimate/`: put its evidence and the existing extension or feature pull request it
  adapts into the branch prompt, and the branch follows the integrate-ultimate skill.
- **Approved memory change:** apply it with one `remember` batch, then `decide {status: 'applied'}`.
- **Rejected:** `decide {status: 'rejected'}`.

A codified memory (`retire` on the proposal) stays until its branch lands; then delete or update it with `remember`.
The session ends by itself once every proposal is settled; the user can also end it from the journal card. An ended
session still accepts approved proposals settling (landed, applied or rejected) and branch landings, never a reopened
one; settle every approved proposal so Fall asleep is offered.

When the built-in automation's dream settles, a `dream.settled` entry says whether it was worth a fresh chapter (landed and
applied changes against the `dream.asleepAfter` setting, default 5). Below it, carry on in this chapter. At or above
it, the input asks you to ask the user: send one message with a `choice` question (Fall asleep now / Later) and point
at the card's Fall asleep button, which only they press. Never call `asleep` for it yourself.

## For the dream branch

You coordinate the dream. You change nothing: no code, no memory, no settings. You read, analyse and propose. The
dream's own bookkeeping (`pass`, `journal`) is part of the job, not a change.

0. Read @ultimate's handoff first: `ultimate.doc('dream.sessions', 1)`, session N's `handoff.text` (or `missing`,
   why there is none). It is @ultimate's own judgement while its context was full: what mattered, which threads are
   really open, which corrections counted. Put it in every pass brief as the primary input; the transcripts are the
   evidence behind it, and a pass checks the handoff against them rather than taking it on trust.
1. Run the six passes in parallel, each as a `dream-pass` subagent (background), with the session number, its pass
   name and the brief below. Before starting each, call `pass {session, pass, status: 'running'}`; when it reports,
   `pass {…, status: 'done', note}` with a one-line note (or `failed` with the reason).
2. Check each report against its evidence; drop what does not hold up.
3. Merge them into the journal and file it with `journal`: `learned` is exactly three short lines in Ultimate's own
   voice ("I learned…", "I keep…", "I'd like…"); `text` is Markdown with one section per pass; `proposals` lists each
   proposed change once: `id` (a slug), `pass`, `title` (one line saying what changes), `size` (S/M/L), `risk`, and
   `retire` (the memory slug it makes redundant) for codify proposals. A project proposal's title asks the question
   with its count ("Agents checked the device API by hand in 6 branches: build a `devices` tool here?"), and its
   `text` section keeps the evidence and what it adapts. Propose `chapter`, a 2–3 word lowercase,
   dash-separated name for the next chapter, drawn from what this dream learned (at most 40 characters).
4. Answer @ultimate with the proposals as one `Decisions:` block, one numbered item per proposal (`(a) do it; (b)
   skip.`), each naming its id, then `My picks:`.

### The passes

Every pass starts from @ultimate's handoff in its brief (when the session has one), then reads with codemode
(`ultimate.entries`, `ultimate.search`, `ultimate.conversations`, `ultimate.trace`), `memory`, `git log` and the code. Every claim cites `#conversation/entry`, a trace error, a commit or `path:line`.
Conversation summaries and abstracts (in the root's tally, `ultimate.entries(<root>)`) are the cheap way in; open a
conversation only where they point at something.

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
  the user). Say the memory delete or update that follows once it is
  codified. Also check the skills that exist: one that is stale, duplicated or never read gets an update or removal
  proposal.
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
