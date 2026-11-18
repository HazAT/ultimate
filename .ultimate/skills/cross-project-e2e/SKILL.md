---
name: cross-project-e2e
description: Test Ultimate end to end through another of the user's projects (another project's @ultimate, its branches and UI) with ultimate.tell and project reads. Use when a change must be proven in a project other than Ultimate itself, or when asked to have another project's @ultimate do something and watch it.
---

# End-to-end test through another project

Only @ultimate can `tell`; a branch asks @ultimate to run this.

1. **Find the project and its URL**: codemode `ultimate.projects()` lists projects with their running instances and
   tailnet URLs. A project that is not running cannot be told anything; say so.
2. **Tell it what to do**, as a user would, in one self-contained message:
   `ultimate.tell({ project, text: 'Start a branch that …; report back when it lands.', reply: true })`, then end your
   turn. The reply is the wait, and failures come back as failed replies: `extensions/messages/README.md`, "Other
   projects' Ultimates". Set no check-back of your own, even for a long job.
3. **No progress**: if a wait stays open with nothing moving, read the other project directly (step 4); a lost
   result is a bug to report.
4. **Watch it** with read-only calls: `ultimate.conversations({ project })` to find the branch,
   `ultimate.entries(id, { project })` for what it did, `ultimate.trace({ project })` for why something did not happen.
5. **Look at its UI** through a coordinator branch: you have no `browser` or `screenshot` tool. Start a branch that
   checks that project's tailnet URL with the `verify-ui` skill and reports back with its screenshots; read its
   report.
6. **Clean up**: ask it (another `tell`) to conclude test branches and delete scratch automations; to-dos it added at
   your request come off with them.

Never change another project's files or settings yourself; its @ultimate does, on request.
