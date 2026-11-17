---
name: adopt-ultimate-setup
description: Tour how Ultimate's own repository configures itself (project model families, a coordinator family, a review team of three reviewers, a lander that runs checks and pushes, worktree setup) and adopt the chosen pieces into the current project's .ultimate/, adapted. Use in onboarding step 5, or when someone asks how Ultimate is set up, wants a review team "like Ultimate's", or wants to copy its setup.
---

# Adopt Ultimate's own setup

Ultimate's repository is built with Ultimate, and its `.ultimate/` is a working example of a project setup. This skill
shows it to the user and copies the pieces they pick into their project, rewritten for that project. Paths below are
relative to the Ultimate clone (`../..` from this skill); read the live files each time, never from memory, since
they change.

## 1. Tour

Read `.ultimate/settings.json` and every file in `.ultimate/agents/`. In one `message {to: 'user', text, questions}`,
explain each piece in one or two plain lines: what it is, why Ultimate has it, and what it would be here. End with one
multi-select question listing the pieces below, plus **None, thanks**.

| Piece             | Ultimate's files                                                                       | Why it exists                                                                                                                                                               |
| ----------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model families    | `settings.json` `modelFamilies` (`lead`, `review`, `fast`)                             | Committed families name each model, so every clone runs the team on the same models whatever its own families say; agents name a family, not a model.                       |
| Review team       | `agents/reviewer-correctness.md`, `reviewer-simplicity.md`, `reviewer-architecture.md` | The shipped `reviewer` starts every `reviewer-*` in parallel and merges one verdict; each has its own focus, on more than one model, so one model's blind spots get caught. |
| Coordinator model | `agents/coordinator.md` (an overlay: `addTools: []`, `family: lead`)                   | Branches plan, decide and verify; the strongest model pays off there.                                                                                                       |
| Lander            | `settings.json` `lander.checks` and `lander.push`                                      | Every landing runs the project's checks on the merged result and pushes; a failure goes back to the submitting branch to fix.                                               |
| Worktree setup    | `settings.json` `isolates.worktree.setup`                                              | Each branch works in a fresh worktree without dependencies; setup installs them before the first tool call.                                                                 |

Not part of the tour, never copied: `extensions.enable` (`voice-live` is a personal choice), `assign.preview` (only for
projects that preview their own extensions), `skills/ultimate-provider-smoke` and `README.md` (both about Ultimate
itself).

## 2. Adapt

Write only the picked pieces into the project's `.ultimate/`, merging into an existing `settings.json` and keeping
files the project already has. Every piece is rewritten for this project: no text about Ultimate's code, conventions,
commands or people may survive.

- **Logins first.** Before naming any model, list the models the user can run (codemode `ultimate.models()`) and use
  only those. Agents name a family (`family:`, keeping their own `thinking` and `fast` where they differ from it);
  the models go in the project's `modelFamilies`, reusing family names the user already has (codemode
  `ultimate.agents()` and the Agents panel show them). Sol (`openai-codex/gpt-6.1-sol`) keeps `fast: true`; other
  models drop it. With one provider, use different models or thinking levels per reviewer and say the team lost its
  model diversity.
- **Review team.** Keep each reviewer's frontmatter shape (`tools: [read, bash]`), its fixed-range rules, P0–P3 levels
  and report format. Rewrite its focus: correctness names this project's real risks (from its code, tests and docs)
  instead of durability and replay; simplicity keeps its rules; architecture is rebuilt from the project's own
  `AGENTS.md`, `CLAUDE.md` or architecture docs, naming the project's patterns and where they live. With no such docs,
  offer to skip the architecture reviewer. Never add a `reviewer.md`: it would replace the lead.
- **Coordinator model.** Recommend Claude Code Opus 5.5 (`claude-code/claude-opus-5-5`, `thinking: high`), as the
  README's "Recommended models" does, with its caveat: the Claude Code provider is experimental, depends on Claude
  Code's protocol and account limits, and subscription coverage is not guaranteed. Use it only with a Claude Code
  login (⌘K → **Claude Code setup…** shows it), as its own family like Ultimate's `lead` rather than `default`,
  which would move every conversation of the project; otherwise offer the strongest model they have, or skip the overlay.
- **Lander.** `checks` are the project's own check and test commands, found in its manifests and CI, in order (an
  array runs as a concurrent group), each with a `timeout`. Add `push` only after the owner says yes, naming the
  remote.
- **Worktree setup.** Follow "Worktree setup" in `skills/integrate-ultimate/SKILL.md` (lockfile install, `.env`,
  database, dev port) and prove it in a scratch worktree as it describes.

## 3. Show and commit

Run `git diff` (and `git status` for new files) on `.ultimate/`, show the user the result in your message, and commit
after they agree. A run of the review team on a recent commit range is a cheap first proof; offer it.
