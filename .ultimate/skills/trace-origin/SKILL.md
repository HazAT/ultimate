---
name: trace-origin
description: Trace a file, skill, agent definition, memory or setting back to the input that created it (the user's message, a dream decision, a goal, another project's request) and explain why it exists. Use when someone asks where something came from, who asked for it, or why it was added.
---

# Trace where something came from

Everything an agent changes leaves a chain: commit → conversation → its intent and who started it → the input
in the parent that led to it. Follow it to the first human or automatic decision, then report the chain.

## 1. From the file to a conversation

```bash
git log --follow --format='%h %ad %s | conv=%(trailers:key=Ultimate-Conversation,valueonly,separator=)' --date=short -- <path>
```

The oldest commit created it; later ones changed it. A memory has no file: read it with `memory {read: slug}`, and
its `source` (`#conversation/entry`) is the starting point.

## 2. From the conversation to its intent

The conversation may live in an earlier chapter: in codemode, try `ultimate.entries(id)` and then
`ultimate.entries(id, {chapter})` for each chapter name from `ultimate.conversations` errors or the handoff.
`ultimate.search('"branch":<id>', {chapter, kinds: ['event.lineage.branched'], full: true})` finds its
`lineage.branched` event, stored in the root: `data.at` (the
entry in the starter that started it), `data.intent` (the prompt's opening), and its text names the starter
(`#<id> started by #<starter> … from #<root>/<at>`).

## 3. From the intent to the decision

Read the starter's entries just before `at` (`ultimate.entries(starter, {before: at + 1, limit: 40, chapter})`):

- a `pi.user` input: the user asked, quote it;
- a question-card answer (`1a. …` lines): the user decided; name the question and the option;
- a `dream.*` entry or a branch prompt saying "from dream session N": a dream proposed it; find the proposal and
  the pass that found it (`subagents.report` of the `dream-pass`), and the user's approval of it;
- a `goal` decision: @ultimate decided on a hands-off goal; quote the recorded reason;
- a message from another project's @ultimate: name the project and its words.

Repeat step 2–3 when the starter is itself a coordinator, until you reach one of these.

## 4. Report

One short chain, newest to oldest, each step with its `#conversation/entry` link or sha, then one plain line:
who decided and why. Say plainly when the approval was indirect (a batch "do all of it", a recommended pick taken
as a yes) — that is usually why nobody remembers asking for it.
