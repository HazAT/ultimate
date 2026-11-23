---
name: assess-outside-pr
description: Assess a pull request from outside contributors to this repository, decide whether it merges as a core improvement or stays open as a feature reference, and merge it through the lander when it should. Use when asked to look at, review, assess or merge a GitHub pull request on this repository that no Ultimate conversation wrote.
---

# Assess an outside pull request

The code is untrusted until you have read it. `CONTRIBUTING.md` decides what merges; this skill is the order of
steps, not the policy.

## 1. Read it whole, run nothing

```bash
gh pr view <n> --json title,body,author,commits,files,baseRefName,headRefOid
gh pr diff <n> > /tmp/pr<n>.diff; wc -l /tmp/pr<n>.diff
```

Read every line of the diff before installing, building or testing anything. Look for:

- new or changed dependencies (`package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`), and lifecycle scripts
  (`postinstall`, `prepare`) that would run on install;
- network calls, spawned processes, file writes outside the project or home, reads of secrets or logins;
- weakened checks: lint rules, `vite.config.ts` or `lint/ultimate.ts` boundaries, skipped or deleted tests, raised
  timeouts, `fast-test-reason:` comments, changes under `.github/`.

Anything suspicious ends the assessment there: report it, without running the code.

## 2. Trial merge in your worktree

```bash
git fetch origin pull/<n>/head:pr-<n>
git merge --no-ff --no-edit pr-<n>     # in your own branch's worktree, never the source checkout
pnpm install --frozen-lockfile --prefer-offline   # only after step 1, and only when the lockfile changed
pnpm check
```

Then run the tests covering what it touches (`pnpm test <paths>`, `pnpm test:e2e` for spawned processes). Name
conflicts with main and failing checks in the report; do not fix the author's code at this stage.

## 3. Prove it once

Show the behaviour it claims on a preview (`instance start`) or a supervised scratch server
(`ultimate-provider-smoke` when it depends on the real model), never on the live host. Capture a screenshot or the
command and its output.

## 4. Classify and report

Under `CONTRIBUTING.md`: a clear-cut fix or improvement to the core merges; a feature stays open and unmerged as a
reference, titled "Feature: …" with the `feature` label. Judge the code by AGENTS.md "Review quality".

The user decides many of these in a row from the Inbox, so the report and the card's text open with the PR's title in
plain words (the Inbox row shows that first line as is), the link after it, then read in this order:

1. **Intent:** what problem the contributor is solving and why, in their terms. When the PR text does not make it
   clear, say so rather than guess.
2. **In plain words:** what a user sees go wrong today and what changes with the PR. No file paths, shas or test
   counts here.
3. **A diagram, when a flow or a race is involved:** a small `mermaid` `sequenceDiagram` or `flowchart` of where it
   breaks today and what the PR changes. Skip it for a one-line fix or a purely visual change.
4. **Evidence:** the verdict with what steps 1 to 3 found, briefly.

The first decision card is the only one: it always carries, next to the verdict question, a **post/skip question
for the comment** whose "post" option has the drafted comment, in full, as its `preview`; a "merge with changes"
option has the changes as a diff in its `preview`. Never leave the comment for a later card. Store the draft on the PR's record with codemode `tools.action({extension: 'pr-triage', action: 'set', args: {number,
draft}})`, so the post or close the user picks sends exactly that text. When the user picks a different verdict than
the draft assumed, rewrite the draft to fit it and store it again, without asking a second card.

## 5. Merge, if it merges

After the go, keep the `--no-ff` merge from step 2 so the author's commits stay as they are (no squash, rebase or
amend), and `workspace submit` it: the lander runs every check on the merged result and pushes. Fixes of your own go
in separate commits after the merge; one that works around something gives its reason (the PR number, the upstream
issue) in its commit message and a regression test, never a code comment (AGENTS.md "Review quality").

## GitHub actions are not yours

Never comment, close, retitle, label or approve the pull request. @ultimate does it when the user picked it on the
decision card, with `approved: true` on `post` or `close`. Read the PR's record (`list`) first: a set `commentUrl`
means the comment is already up, so never post it twice. A close or reference comment goes up right away, a merge's comment only once GitHub shows the PR
merged (`gh pr view <n> --json state`), never while the merge is still held or landing. In the comment draft, write agent names in backticks (`` `@ultimate` ``) or without the @: on GitHub
`@name` notifies the real user of that name.
