What isn't set up on this machine, and what that costs: one status-line item, `⚠ N setup issues`, shown only while
something warns. Its popover lists every area with what is set up, what is missing, what the user loses and a fix
button (a ⌘K command, or the Secrets panel at the missing secret).

| Area              | Warns when                                                                                                                    | Fix               |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| Summary model     | the configured model has no login here (the default falls back, see below)                                                    | Summary model…    |
| Agent models      | a definition pins a model whose provider has no login here                                                                    | Log in            |
| Agent definitions | a definition file fails to parse, or a user or project file replaces a built-in whole instead of extending it with `addTools` |                   |
| Providers         | a provider's latest call on this machine failed (`health`)                                                                    | Log in again      |
| Secrets           | an enabled extension lacks a secret it declares                                                                               | the Secrets panel |
| Extensions        | an enabled extension's server facet failed to load                                                                            | Extensions panel  |
| Cloud backup      | `cloud.url` is set but `ULTIMATE_CLOUD_TOKEN` or the snapshot key is missing; `info` while unset                              | Join              |
| Tailscale         | never; `info` while not published                                                                                             |                   |
| Lander checks     | never; `info` while `lander.checks` is empty                                                                                  |                   |
| Worktree setup    | the project is isolatable, has a package manifest, and no `isolates.worktree.setup`; an explicit `[]` is "none, by choice"    |                   |
| Project memory    | a listed root has no memories (`lineage.memory`), so its branches start from the full tally; ask @ultimate for a review       |                   |

A definition pinned to a provider without a login still loads (Pi resolves its model among every known model) and
fails at its first model call, so its row says that.

## Summary model fallback

`conversations`' `summaryModelStatus()` says what the summary features run on. When the **default** summary model has
no login here, it falls back to the first available of a short known-good list (`FALLBACK_SUMMARY_MODELS`), else the
cheapest available model, and says so once as a notice; the Summary model row warns. A model the settings name
explicitly never falls back: the features are off and the row warns.

## The agent's note

@ultimate hears about setup through a hidden `setup.note` entry placed
before an input that starts its run, by the patched `beforeInput` hook, only when its set of warnings differs from the
one it last heard (`setup.seen`, per conversation), and once more with "resolved" when they clear. No system-prompt
section, so the prompt stays cached. The check is cached for 30 seconds.

## Actions

`check` returns every area as `{ area, status: 'warn' | 'info' | 'ok', summary, impact?, fix? }`, warnings first (a
poll action).
