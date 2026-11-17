Ultimate's system prompt: coding guidelines, project context, skills, and the source reload layers.

The system prompt stays the same across builds, so a reload of an extension keeps the prompt cache. Instead, the input that starts a
conversation's run gets a `prompt.build` note when the build differs from the one its last run started on: "Build
changed: <old> → <new> · generation N · changed: …". The note is decided in the commit that places the input (the
patched `beforeInput` hook), and the `prompt.build` document records the last build each conversation saw. A new
conversation records its first build silently, and a fork starts from its parent's.

The primary agent (@ultimate) also follows its instructions there. When its definition's
text differs from the conversation's, the hook re-applies it, so a typed input picks up an updated `agents/ultimate.md`
as Messages deliveries already did. The document keeps a hash of each project context file (`AGENTS.md`) and of the
clone's `AGENTS.md`, `docs/*.md` and `agents/*.md`, and the note names the definition re-applied and the files changed
since the last run ("Instructions changed: … · Docs changed: …"). Other agents keep the instructions they started with.

A build note also names what landed: the document keeps the clone's commit each run started on, and the first-parent
commits since then, grouped by the branch that made them (a lander merge's `from #N`, else the `Ultimate-Conversation`
trailer, a subagent under its owner), become "landed: <branch title> (#N), …". A commit made outside Ultimate is named
by its subject; a reload without commits (a hand edit in the clone) names none.

The transcript shows every note as one quiet divider: "↻ Reloaded · <branch> #N · <branch> #M · +K more" with links to
the branches, else "↻ Reloaded · build a → b" or "↻ Instructions changed · …", its full text on hover. `self`'s
update toast names the landing likewise ("Landed <branch>") when a `workspaces.landed` event comes within a minute
of the page switching to a new web bundle.
